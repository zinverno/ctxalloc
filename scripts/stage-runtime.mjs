// Assemble built applications and production dependencies; never copy a source corpus or config.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
const destination = resolve(process.argv[2]);
mkdirSync(destination, { recursive: true });
cpSync('node_modules', join(destination, 'node_modules'), {
  recursive: true,
  dereference: false,
  verbatimSymlinks: true,
});
cpSync('package.json', join(destination, 'package.json'));
for (const group of ['apps', 'packages'])
  for (const name of readdirSync(group)) {
    const source = join(group, name);
    const target = join(destination, group, name);
    mkdirSync(target, { recursive: true });
    for (const entry of ['package.json', 'dist', 'node_modules']) {
      try {
        cpSync(join(source, entry), join(target, entry), {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      } catch (error) {
        if (entry !== 'node_modules' || error.code !== 'ENOENT') throw error;
      }
    }
  }
