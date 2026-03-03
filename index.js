#!/usr/bin/env node
// template-cli — Mustache-style template engine. Zero dependencies.
// Usage: tmpl <command> [options]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, basename, extname, relative } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI helpers
const isTTY = process.stdout.isTTY;
const c = {
  reset:  isTTY ? '\x1b[0m'  : '',
  bold:   isTTY ? '\x1b[1m'  : '',
  dim:    isTTY ? '\x1b[2m'  : '',
  green:  isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan:   isTTY ? '\x1b[36m' : '',
  red:    isTTY ? '\x1b[31m' : '',
  blue:   isTTY ? '\x1b[34m' : '',
};
const ok   = (msg) => process.stderr.write(c.green + 'v ' + c.reset + msg + '\n');
const fail = (msg) => { process.stderr.write(c.red + 'x ' + c.reset + msg + '\n'); process.exit(1); };
const warn = (msg) => process.stderr.write(c.yellow + '! ' + c.reset + msg + '\n');
const info = (msg) => process.stderr.write(c.cyan + '> ' + c.reset + msg + '\n');

// Built-in filters
const FILTERS = {
  upper:  (v) => String(v).toUpperCase(),
  lower:  (v) => String(v).toLowerCase(),
  title:  (v) => String(v).replace(/\b\w/g, (ch) => ch.toUpperCase()),
  kebab:  (v) => String(v).replace(/\s+/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
  camel:  (v) => String(v).replace(/[-_\s]+(.)/g, (_, ch) => ch.toUpperCase()).replace(/^(.)/, (ch) => ch.toLowerCase()),
};

// HTML escape
function htmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Variable extraction
function extractVariables(template) {
  const vars = new Set();
  const re = /\{\{\{?([^!#/>{][^}]*?)\}?\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) {
    const inner = m[1].trim();
    const name = inner.split('|')[0].trim();
    if (name && name !== 'this' && name !== 'else' && !/^[#/]/.test(name)) {
      vars.add(name);
    }
  }
  const blockRe = /\{\{#(?:if|each)\s+(\w+)\}\}/g;
  while ((m = blockRe.exec(template)) !== null) {
    vars.add(m[1].trim());
  }
  return [...vars];
}

// Core renderer
function render(template, vars, opts) {
  const missingOk = opts && opts.missingOk;
  const strict = opts && opts.strict;
  const partialDir = opts && opts.partialDir;
  const usedVars = new Set();

  // Strip comments
  let out = template.replace(/\{\{![^}]*\}\}/g, '');

  // Partials
  out = out.replace(/\{\{>\s*([^}]+?)\s*\}\}/g, (_, partialPath) => {
    const resolvedPath = partialDir
      ? join(partialDir, partialPath.trim())
      : partialPath.trim();
    if (!existsSync(resolvedPath)) {
      if (missingOk) return '';
      fail('Partial not found: ' + resolvedPath);
    }
    const partialContent = readFileSync(resolvedPath, 'utf8');
    return render(partialContent, vars, Object.assign({}, opts, { partialDir: dirname(resolvedPath) }));
  });

  // #if blocks
  out = out.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
    usedVars.add(key);
    const val = vars[key];
    const truthy = Array.isArray(val) ? val.length > 0 : (val === 'false' || val === '0' || val === '' ? false : Boolean(val));
    const parts = body.split(/\{\{else\}\}/);
    const thenPart = parts[0];
    const elsePart = parts[1] !== undefined ? parts[1] : '';
    return truthy ? render(thenPart, vars, opts) : render(elsePart, vars, opts);
  });

  // #each blocks
  out = out.replace(/\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, key, body) => {
    usedVars.add(key);
    const arr = vars[key];
    if (!Array.isArray(arr)) {
      if (missingOk) return '';
      if (arr === undefined || arr === null) {
        warn('Variable "' + key + '" used in #each is not defined');
        return '';
      }
      fail('Variable "' + key + '" used in #each is not an array (got ' + typeof arr + ')');
    }
    return arr.map((item, idx) => {
      const itemVars = Object.assign({}, vars, {
        this: item,
        '@index': idx,
        '@first': idx === 0,
        '@last': idx === arr.length - 1,
      });
      if (typeof item === 'object' && item !== null) Object.assign(itemVars, item);
      return render(body, itemVars, opts);
    }).join('');
  });

  // Triple braces: no HTML escape
  out = out.replace(/\{\{\{([^}]+?)\}\}\}/g, (match, inner) => {
    const parts = inner.trim().split('|').map(function(s) { return s.trim(); });
    const rawKey = parts[0];
    const filterParts = parts.slice(1);
    usedVars.add(rawKey);
    if (rawKey in vars) {
      let val = String(vars[rawKey]);
      for (const f of filterParts) {
        if (FILTERS[f]) val = FILTERS[f](val);
        else fail('Unknown filter "' + f + '"');
      }
      return val;
    }
    if (missingOk) return match;
    fail('Undefined variable: ' + rawKey);
  });

  // Double braces: HTML escape
  out = out.replace(/\{\{([^#/!>{][^}]*?)\}\}/g, (match, inner) => {
    const parts = inner.trim().split('|').map(function(s) { return s.trim(); });
    const rawKey = parts[0];
    const filterParts = parts.slice(1);
    usedVars.add(rawKey);
    if (rawKey in vars) {
      let val = htmlEscape(String(vars[rawKey]));
      for (const f of filterParts) {
        if (FILTERS[f]) val = FILTERS[f](val);
        else fail('Unknown filter "' + f + '"');
      }
      return val;
    }
    if (missingOk) return match;
    fail('Undefined variable: ' + rawKey);
  });

  if (strict) {
    for (const key of Object.keys(vars)) {
      if (!usedVars.has(key) && key !== 'this' && !key.startsWith('@')) {
        fail('--strict: variable "' + key + '" was provided but not used in template');
      }
    }
  }

  return out;
}

// .env parser
function parseEnvFile(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const vars = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

// Arg parser
function parseArgs(argv) {
  const args = { _: [], flags: {}, vars: {}, varFiles: [], output: null, env: false, missingOk: false, strict: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--var' || a === '-v') {
      const pair = argv[++i];
      if (!pair || !pair.includes('=')) fail('--var requires KEY=VALUE format');
      const eqIdx = pair.indexOf('=');
      args.vars[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if (a === '--vars') {
      args.varFiles.push(argv[++i]);
    } else if (a === '--output' || a === '-o') {
      args.output = argv[++i];
    } else if (a === '--env') {
      args.env = true;
    } else if (a === '--missing-ok') {
      args.missingOk = true;
    } else if (a === '--strict') {
      args.strict = true;
    } else if (a.startsWith('--')) {
      args.flags[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
    i++;
  }
  return args;
}

// Load variables from all sources
function loadVars(parsedArgs, cwd) {
  const base = cwd || process.cwd();
  let vars = {};
  for (const vf of parsedArgs.varFiles) {
    const resolved = vf.startsWith('/') ? vf : join(base, vf);
    if (!existsSync(resolved)) fail('Vars file not found: ' + resolved);
    const raw = readFileSync(resolved, 'utf8');
    try {
      Object.assign(vars, JSON.parse(raw));
    } catch (e) {
      fail('Invalid JSON in vars file: ' + vf + '\n  ' + e.message);
    }
  }
  if (parsedArgs.env) {
    const envPath = join(base, '.env');
    if (!existsSync(envPath)) fail('.env file not found in ' + base);
    Object.assign(vars, parseEnvFile(envPath));
  }
  Object.assign(vars, parsedArgs.vars);
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try { vars[k] = JSON.parse(v); } catch (_) { /* keep as string */ }
    }
  }
  return vars;
}

// Scaffold directory
function scaffoldDir(srcDir, destDir, vars, opts) {
  if (!existsSync(srcDir)) fail('Template directory not found: ' + srcDir);
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir);
  let count = 0;
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const renderedName = render(entry, vars, Object.assign({}, opts, { missingOk: true }));
    const destPath = join(destDir, renderedName);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      count += scaffoldDir(srcPath, destPath, vars, opts);
    } else {
      const content = readFileSync(srcPath, 'utf8');
      const rendered = render(content, vars, Object.assign({}, opts, { partialDir: srcDir }));
      writeFileSync(destPath, rendered, 'utf8');
      ok(relative(process.cwd(), destPath));
      count++;
    }
  }
  return count;
}

// Commands
function cmdRender(args) {
  const templatePath = args._[0];
  if (!templatePath) fail('Usage: tmpl render <template> [options]');
  if (!existsSync(templatePath)) fail('Template not found: ' + templatePath);
  const vars = loadVars(args);
  const content = readFileSync(templatePath, 'utf8');
  const opts = { missingOk: args.missingOk, strict: args.strict, partialDir: dirname(templatePath) };
  const rendered = render(content, vars, opts);
  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, rendered, 'utf8');
    ok('Rendered -> ' + args.output);
  } else {
    process.stdout.write(rendered);
  }
}

function cmdScaffold(args) {
  const srcDir = args._[0];
  if (!srcDir) fail('Usage: tmpl scaffold <templates-dir> --output <dest-dir> [options]');
  if (!args.output) fail('--output <dest-dir> is required for scaffold');
  const vars = loadVars(args);
  const opts = { missingOk: args.missingOk, strict: args.strict };
  info('Scaffolding ' + srcDir + ' -> ' + args.output);
  const count = scaffoldDir(srcDir, args.output, vars, opts);
  ok('Done. ' + count + ' file(s) written to ' + args.output);
}

function cmdList(args) {
  const dir = args._[0] || '.';
  if (!existsSync(dir)) fail('Directory not found: ' + dir);
  const stat = statSync(dir);
  if (!stat.isDirectory()) fail('Not a directory: ' + dir);
  const entries = readdirSync(dir, { recursive: true });
  const templates = entries.filter(function(e) {
    try { return statSync(join(dir, e)).isFile(); } catch (_) { return false; }
  });
  if (templates.length === 0) { warn('No files found in ' + dir); return; }
  process.stdout.write(c.bold + 'Templates in ' + dir + ':' + c.reset + '\n\n');
  for (const t of templates) {
    const fullPath = join(dir, t);
    let content;
    try { content = readFileSync(fullPath, 'utf8'); } catch (_) { continue; }
    const vars = extractVariables(content);
    process.stdout.write('  ' + c.cyan + t + c.reset + '\n');
    if (vars.length > 0) {
      process.stdout.write('    ' + c.dim + 'Variables: ' + vars.map(function(v) { return '{{' + v + '}}'; }).join(', ') + c.reset + '\n');
    } else {
      process.stdout.write('    ' + c.dim + 'No variables' + c.reset + '\n');
    }
    process.stdout.write('\n');
  }
}

function cmdValidate(args) {
  const templatePath = args._[0];
  if (!templatePath) fail('Usage: tmpl validate <template>');
  if (!existsSync(templatePath)) fail('Template not found: ' + templatePath);
  const content = readFileSync(templatePath, 'utf8');
  const vars = extractVariables(content);
  const openIf = (content.match(/\{\{#if\s+\w+\}\}/g) || []).length;
  const closeIf = (content.match(/\{\{\/if\}\}/g) || []).length;
  const openEach = (content.match(/\{\{#each\s+\w+\}\}/g) || []).length;
  const closeEach = (content.match(/\{\{\/each\}\}/g) || []).length;
  let valid = true;
  if (openIf !== closeIf) {
    process.stderr.write(c.red + 'x' + c.reset + ' Mismatched {{#if}} blocks: ' + openIf + ' opened, ' + closeIf + ' closed\n');
    valid = false;
  }
  if (openEach !== closeEach) {
    process.stderr.write(c.red + 'x' + c.reset + ' Mismatched {{#each}} blocks: ' + openEach + ' opened, ' + closeEach + ' closed\n');
    valid = false;
  }
  if (valid) ok(templatePath + ' -- syntax valid');
  if (vars.length > 0) {
    process.stdout.write('\n' + c.bold + 'Required variables (' + vars.length + '):' + c.reset + '\n');
    for (const v of vars) {
      process.stdout.write('  ' + c.cyan + '{{' + v + '}}' + c.reset + '\n');
    }
  } else {
    process.stdout.write('\n' + c.dim + 'No variables found' + c.reset + '\n');
  }
  if (!valid) process.exit(1);
}

function cmdHelp() {
  process.stdout.write('\n' +
    c.bold + 'template-cli' + c.reset + ' ' + c.dim + 'v1.0.0' + c.reset +
    ' -- Mustache-style template engine. Zero dependencies.\n\n' +
    c.bold + 'USAGE' + c.reset + '\n' +
    '  tmpl <command> [options]\n\n' +
    c.bold + 'COMMANDS' + c.reset + '\n' +
    '  ' + c.cyan + 'render' + c.reset + '   <template>           Render a template file\n' +
    '  ' + c.cyan + 'scaffold' + c.reset + ' <dir>                Render an entire directory of templates\n' +
    '  ' + c.cyan + 'list' + c.reset + '     [dir]                List templates and their variables\n' +
    '  ' + c.cyan + 'validate' + c.reset + ' <template>           Check template syntax\n\n' +
    c.bold + 'OPTIONS' + c.reset + '\n' +
    '  ' + c.yellow + '--var' + c.reset + ' KEY=VALUE             Inline variable (repeatable)\n' +
    '  ' + c.yellow + '--vars' + c.reset + ' file.json            Load variables from JSON file\n' +
    '  ' + c.yellow + '--env' + c.reset + '                       Load variables from .env in cwd\n' +
    '  ' + c.yellow + '--output' + c.reset + ', -o <path>         Write output to file/directory\n' +
    '  ' + c.yellow + '--missing-ok' + c.reset + '                Leave unresolved {{vars}} as-is\n' +
    '  ' + c.yellow + '--strict' + c.reset + '                    Fail if any variable is unused\n\n' +
    c.bold + 'TEMPLATE SYNTAX' + c.reset + '\n' +
    '  ' + c.green + '{{name}}' + c.reset + '                    Variable interpolation (HTML-escaped)\n' +
    '  ' + c.green + '{{{raw}}}' + c.reset + '                   Raw output (no HTML escaping)\n' +
    '  ' + c.green + '{{name | upper}}' + c.reset + '            Filters: upper, lower, title, kebab, camel\n' +
    '  ' + c.green + '{{#if condition}}...{{/if}}' + c.reset + ' Conditional block\n' +
    '  ' + c.green + '{{#each items}}...{{/each}}' + c.reset + ' Loop over array (use {{this}} inside)\n' +
    '  ' + c.green + '{{> partial.md}}' + c.reset + '            Include another template file\n' +
    '  ' + c.green + '{{! comment }}' + c.reset + '              Ignored in output\n\n' +
    c.bold + 'EXAMPLES' + c.reset + '\n' +
    '  tmpl render template.md --var name=Nick --var project=MyApp\n' +
    '  tmpl render template.md --vars data.json --output result.md\n' +
    '  tmpl render template.md --env\n' +
    '  tmpl scaffold ./templates --output ./my-project --vars config.json\n' +
    '  tmpl list ./templates\n' +
    '  tmpl validate template.md\n\n' +
    c.dim + 'Repo: https://github.com/NickCirv/template-cli' + c.reset + '\n\n'
  );
}

// Stdin support
async function readStdin() {
  if (process.stdin.isTTY) return null;
  return new Promise(function(resolve) {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function(chunk) { data += chunk; });
    process.stdin.on('end', function() { resolve(data); });
  });
}

// Main entry
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    cmdHelp();
    return;
  }
  const command = argv[0];
  const rest = argv.slice(1);
  const args = parseArgs(rest);

  switch (command) {
    case 'render':
      if (args._[0] === '-') {
        const stdinContent = await readStdin();
        if (!stdinContent) fail('No stdin content received');
        const vars = loadVars(args);
        const opts = { missingOk: args.missingOk, strict: args.strict, partialDir: process.cwd() };
        const rendered = render(stdinContent, vars, opts);
        if (args.output) {
          mkdirSync(dirname(args.output), { recursive: true });
          writeFileSync(args.output, rendered, 'utf8');
          ok('Rendered -> ' + args.output);
        } else {
          process.stdout.write(rendered);
        }
      } else {
        cmdRender(args);
      }
      break;
    case 'scaffold':
      cmdScaffold(args);
      break;
    case 'list':
      cmdList(args);
      break;
    case 'validate':
      cmdValidate(args);
      break;
    case 'help':
      cmdHelp();
      break;
    default:
      process.stderr.write(c.red + 'Unknown command: ' + command + c.reset + '\n');
      cmdHelp();
      process.exit(1);
  }
}

main().catch(function(e) {
  process.stderr.write(c.red + 'Fatal: ' + e.message + c.reset + '\n');
  process.exit(1);
});
