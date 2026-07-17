'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readPackage(directory) {
  const filename = path.join(directory, 'package.json');
  if (!fs.existsSync(filename)) return null;
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new Error(`invalid package.json at ${filename}: ${error.message}`);
  }
}

function validProject(directory) {
  return fs.existsSync(directory) && fs.statSync(directory).isDirectory() && Boolean(readPackage(directory));
}

function detectFolders(cwd, overrides = {}) {
  const pairs = overrides.pairs || [['frontend', 'backend'], ['client', 'server']];
  const found = pairs.filter(([front, back]) =>
    validProject(path.join(cwd, front)) && validProject(path.join(cwd, back)));

  let frontend = overrides.frontend && path.resolve(cwd, overrides.frontend);
  let backend = overrides.backend && path.resolve(cwd, overrides.backend);

  if (!frontend && !backend) {
    if (found.length > 1) {
      throw new Error('ambiguous project layout: multiple configured folder pairs exist; use --frontend-dir and --backend-dir');
    }
    if (found.length === 1) {
      frontend = path.join(cwd, found[0][0]);
      backend = path.join(cwd, found[0][1]);
    } else {
      const basename = path.basename(cwd).toLowerCase();
      for (const [front, back] of pairs) {
        if (basename === front || basename === back) {
          const parent = path.dirname(cwd);
          if (validProject(path.join(parent, front)) && validProject(path.join(parent, back))) {
            throw new Error(`run ports-manager from the parent directory: ${parent}`);
          }
        }
      }
      throw new Error('no paired frontend/backend or client/server package.json projects found');
    }
  } else if (!frontend || !backend) {
    const wanted = frontend ? 'backend' : 'frontend';
    const candidates = pairs.map((pair) => pair[wanted === 'frontend' ? 0 : 1])
      .map((name) => path.join(cwd, name)).filter(validProject);
    if (candidates.length !== 1) throw new Error(`cannot infer ${wanted}; specify --${wanted}-dir`);
    if (wanted === 'frontend') frontend = candidates[0];
    else backend = candidates[0];
  }

  if (!validProject(frontend)) throw new Error(`frontend must be a directory containing package.json: ${frontend}`);
  if (!validProject(backend)) throw new Error(`backend must be a directory containing package.json: ${backend}`);
  if (path.resolve(frontend) === path.resolve(backend)) throw new Error('frontend and backend must be distinct directories');
  return { frontend, backend };
}

function hasDependency(pkg, name) {
  return Boolean((pkg.dependencies && pkg.dependencies[name]) ||
    (pkg.devDependencies && pkg.devDependencies[name]));
}

function classifyProject(directory, role) {
  const pkg = readPackage(directory);
  const scripts = pkg.scripts || {};
  const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
  if (!script) throw new Error(`${directory} has neither a dev nor start script`);

  let framework = 'generic';
  if (role === 'frontend') {
    if (hasDependency(pkg, 'react-scripts')) framework = 'cra';
    else if (hasDependency(pkg, 'vite')) framework = 'vite';
    else if (hasDependency(pkg, 'next')) framework = 'next';
  } else {
    for (const [dependency, name] of [
      ['@nestjs/core', 'nest'], ['express', 'express'], ['koa', 'koa'], ['fastify', 'fastify']
    ]) {
      if (hasDependency(pkg, dependency)) {
        framework = name;
        break;
      }
    }
  }
  return { directory, pkg, role, framework, script };
}

function likelyEntryFiles(project) {
  const scriptText = (project.pkg.scripts && project.pkg.scripts[project.script]) || '';
  const entries = [];
  const match = scriptText.match(/(?:node|nodemon|tsx|ts-node)\s+(?:--\S+\s+)*["']?([^\s"']+\.[cm]?[jt]s)/);
  if (match) entries.push(match[1]);
  for (const candidate of ['server.js', 'index.js', 'app.js', 'src/server.js', 'src/index.js', 'src/main.ts']) {
    if (!entries.includes(candidate)) entries.push(candidate);
  }
  return entries.map((entry) => path.resolve(project.directory, entry)).filter(fs.existsSync);
}

function scanBackend(project) {
  const files = likelyEntryFiles(project).slice(0, 3);
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const hasEnvPort = /\bprocess\.env\.PORT\b|\bprocess\.env\[['"]PORT['"]\]/.test(source);
  const literals = [...source.matchAll(/\.listen\s*\(\s*(\d{2,5})\b/g)].map((match) => Number(match[1]));
  const corsDetected = /\brequire\s*\(\s*['"]cors['"]\s*\)|\bfrom\s+['"]cors['"]|\bapp\.use\s*\(\s*cors\s*\(/.test(source) ||
    hasDependency(project.pkg, 'cors');
  return { files, hasEnvPort, literals: [...new Set(literals)], corsDetected };
}

module.exports = {
  classifyProject, detectFolders, hasDependency, readPackage, scanBackend, validProject
};
