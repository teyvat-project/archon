// pack 前にリポジトリ直下の README.md と LICENSE をこのパッケージにコピーする（npm はパッケージ直下のものしか同梱・表示しないため）。
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['README.md', 'LICENSE']) {
  copyFileSync(join(pkgRoot, '..', '..', name), join(pkgRoot, name));
}
