/**
 * Workbooks the tests read. Oracle's example workbooks aren't published with
 * this project: `npm run examples` copies the ones the tests use into
 * fixtures/ from a Crystal Ball install, and tests that need them are skipped
 * without them. The project's own example workbooks (examples/) are always here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixtures = join(__dirname, 'fixtures');

export const hasOracle = (...names: string[]) => names.every((n) => existsSync(join(fixtures, n)));
export const oracleFile = (name: string) => readFileSync(join(fixtures, name));
export const ownFile = (name: string) => readFileSync(join(__dirname, '..', '..', '..', 'examples', name));
