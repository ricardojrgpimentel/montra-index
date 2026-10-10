import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { catalogueTextErrors, draftCatalogueText } from "./catalogue-text.mjs";

const schema = JSON.parse(await fs.readFile(new URL("../../schema/app.schema.json", import.meta.url)));
const sample = JSON.parse(await fs.readFile(new URL("../../apps/newpipe.json", import.meta.url)));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("catalogue language policy", () => {
  it("accepts English alone and optional native and regional translations", () => {
    const entry = { ...sample, description: { en: sample.description.en }, summaryTranslations: { ja: "元の説明をそのまま使います", "pt-BR": "Um resumo brasileiro" } };
    assert.equal(validate(entry), true);
    assert.deepEqual(catalogueTextErrors(entry), []);
    delete entry.summaryTranslations;
    assert.equal(validate(entry), true);
  });
  it("rejects entries without English and invalid translation values or tags", () => {
    assert.equal(validate({ ...sample, description: { pt: sample.description.pt } }), false);
    assert.equal(validate({ ...sample, summaryTranslations: { "not a locale": "A translated summary" } }), false);
    assert.equal(validate({ ...sample, summaryTranslations: { fr: " " } }), false);
  });
  it("keeps original prose in schema-valid drafts, but rejects publishing placeholders", () => {
    const draft = { ...sample, ...draftCatalogueText("  元の説明をそのまま使います  ") };
    assert.equal(validate(draft), true);
    assert.equal(draft.description.und, "元の説明をそのまま使います");
    assert.equal(catalogueTextErrors(draft).length, 2);
    assert.equal(catalogueTextErrors({ ...draft, summary: "  " }).length, 2);
  });
});
