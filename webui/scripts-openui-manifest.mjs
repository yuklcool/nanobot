import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(path.join(root, '.openui-build-'));
try {
  const source = path.join(root, 'src/openui/chat-library.tsx');
  const output = path.join(temporary, 'library.mjs');
  await build({ entryPoints: [source], outfile: output, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react-i18next', 'react/jsx-runtime', 'lucide-react', '@openuidev/react-lang', 'zod'] });
  const { chatLibrary } = await import(pathToFileURL(output).href);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const basis = { schema_version: 1, sdk: pkg.dependencies['@openuidev/react-lang'],
    core: pkg.dependencies['@openuidev/lang-core'],
    data_contract_hash: createHash('sha256').update((await readFile(path.join(root, 'src/openui/data-contract.ts'), 'utf8')).replaceAll('\r\n', '\n')).digest('hex'),
    source_hash: createHash('sha256').update((await readFile(source, 'utf8')).replaceAll('\r\n', '\n')).digest('hex'), prompt: chatLibrary.prompt() };
  const manifest = JSON.stringify({ ...basis,
    library_hash: createHash('sha256').update(JSON.stringify(basis)).digest('hex') }, null, 2) + '\n';
  const target = path.join(root, '../nanobot/openui/generated/chat-library.json');
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8')).replaceAll('\r\n', '\n') !== manifest) throw new Error('Regenerate the OpenUI manifest');
  } else await writeFile(target, manifest);
} finally { await rm(temporary, { recursive: true, force: true }); }
