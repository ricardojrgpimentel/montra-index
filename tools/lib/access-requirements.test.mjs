import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const read = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const source = await read('../../schema/app.schema.json');
const generated = await read('../../schema/index.schema.json');
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const accessSchema = source.properties.accessRequirements;
const validate = ajv.compile(accessSchema);
const access = { mode: 'required', methods: ['root'], note: { en: 'Root is required.' }, guideUrl: 'https://example.org/guide' };

describe('access requirements contract', () => {
  it('uses identical rules for source entries and the generated catalogue', () => {
    assert.deepEqual(accessSchema, generated.properties.apps.items.properties.accessRequirements);
  });
  it('accepts required, optional and alternative methods', () => {
    for (const mode of ['required', 'optional']) {
      for (const methods of [['root'], ['shizuku'], ['shizuku', 'root'], ['root', 'adb'], ['deviceOwner']]) {
        assert.equal(validate({ ...access, mode, methods }), true, JSON.stringify(validate.errors));
      }
    }
  });
  it('rejects ambiguous flags, missing evidence, empty or duplicate methods', () => {
    for (const invalid of [
      { ...access, mode: true }, { ...access, mode: 'sometimes' },
      { ...access, methods: [] }, { ...access, methods: ['root', 'root'] },
      { ...access, methods: ['typo'] }, { ...access, note: { pt: 'Só português' } },
      { ...access, note: { en: '' } }, { ...access, guideUrl: 'javascript:alert(1)' },
      { ...access, guideUrl: 'http://example.org' }, { ...access, unrecognized: true },
    ]) assert.equal(validate(invalid), false, JSON.stringify(invalid));
    for (const field of ['mode', 'methods', 'note', 'guideUrl']) {
      const invalid = { ...access }; delete invalid[field];
      assert.equal(validate(invalid), false, field);
    }
  });
  it('continues to accept legacy entries without requirements', async () => {
    const validateApp = ajv.compile(source);
    assert.equal(validateApp(await read('../../apps/newpipe.json')), true);
  });
});
