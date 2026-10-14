// Schema validation of every committed vector file. Runs in the Node project only: Ajv compiles
// schemas with `new Function`, which workerd forbids, and the files are identical in every runtime.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, test } from 'vitest';
import envelopeSchema from '../schema/vector-file.schema.json';
import { vectorFiles } from './registry';

const caseSchemas = import.meta.glob<object>('../*/case.schema.json', {
  eager: true,
  import: 'default',
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEnvelope = ajv.compile(envelopeSchema);

test('at least one vector suite is committed', () => {
  expect(vectorFiles.length).toBeGreaterThan(0);
});

for (const { directory, file } of vectorFiles) {
  describe(`${directory}/vectors.json`, () => {
    test('matches schema/vector-file.schema.json', () => {
      expect(validateEnvelope(file), ajv.errorsText(validateEnvelope.errors)).toBe(true);
    });

    test('names its own directory as the suite', () => {
      expect(file.suite).toBe(directory);
    });

    test('has unique case ids', () => {
      const ids = file.cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test('every case matches the suite case.schema.json', () => {
      const schema = caseSchemas[`../${directory}/case.schema.json`];
      expect(schema, `test-vectors/${directory}/case.schema.json is missing`).toBeDefined();
      const validateCase = ajv.compile(schema as object);
      for (const testCase of file.cases) {
        expect(
          validateCase(testCase),
          `${testCase.id}: ${ajv.errorsText(validateCase.errors)}`,
        ).toBe(true);
      }
    });
  });
}
