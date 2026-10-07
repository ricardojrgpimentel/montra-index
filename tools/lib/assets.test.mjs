// Tests for the release-asset logic. Run with: pnpm test
//
// These are the rules that decide which file a user's phone will download, so
// they are the last place to be clever or vague.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferAbi, slugify, suggestPattern } from "./assets.mjs";

const apk = (name, size = 1000) => ({ name, size });

describe("inferAbi", () => {
  it("reconhece as arquiteturas usuais", () => {
    assert.equal(inferAbi("app-arm64-v8a-release.apk"), "arm64-v8a");
    assert.equal(inferAbi("app-aarch64.apk"), "arm64-v8a");
    assert.equal(inferAbi("app-armeabi-v7a-release.apk"), "armeabi-v7a");
    assert.equal(inferAbi("findroid-v1.1.0-libre-armeabi-v7a.apk"), "armeabi-v7a");
    assert.equal(inferAbi("app-x86_64-release.apk"), "x86_64");
    assert.equal(inferAbi("app-x86-release.apk"), "x86");
    assert.equal(inferAbi("app-universal-release.apk"), "universal");
  });

  it("não confunde arm64 com arm, nem x86_64 com x86", () => {
    assert.equal(inferAbi("koreader-android-arm64-v2026.07.1.apk"), "arm64-v8a");
    assert.equal(inferAbi("koreader-android-arm-v2026.07.1.apk"), "armeabi-v7a");
    assert.equal(inferAbi("lib-x86_64.so.apk"), "x86_64");
    assert.equal(inferAbi("lib-x86.so.apk"), "x86");
  });

  it("devolve null quando o nome não diz nada", () => {
    assert.equal(inferAbi("app-release.apk"), null);
    assert.equal(inferAbi("PipePipe_5.4.0-release.apk"), null);
  });

  it("não vê 'arm' dentro de outra palavra", () => {
    // "charm" não é ARM, e um falso positivo aqui escolheria o APK errado.
    assert.equal(inferAbi("charm-release.apk"), null);
  });
});

describe("suggestPattern", () => {
  it("um único APK vira um assetPattern exato", () => {
    const s = suggestPattern([apk("NewPipe_v0.29.1.apk", 11_000_000)]);
    assert.equal(s.assetPattern, "NewPipe_v0.29.1.apk");
    assert.equal(s.abiAssets, null);
    assert.equal(s.primary.name, "NewPipe_v0.29.1.apk");
  });

  it("APKs por ABI viram abiAssets, com o nome exato quando é único", () => {
    const s = suggestPattern([
      apk("PipePipe_5.4.0-arm64-v8a-release.apk"),
      apk("PipePipe_5.4.0-armeabi-v7a-release.apk"),
      apk("PipePipe_5.4.0-x86_64-release.apk"),
    ]);
    assert.equal(s.assetPattern, null);
    assert.deepEqual(s.abiAssets, {
      "arm64-v8a": "PipePipe_5.4.0-arm64-v8a-release.apk",
      "armeabi-v7a": "PipePipe_5.4.0-armeabi-v7a-release.apk",
      "x86_64": "PipePipe_5.4.0-x86_64-release.apk",
    });
    assert.equal(s.primary.name, "PipePipe_5.4.0-arm64-v8a-release.apk");
  });

  it("variantes múltiplas por ABI: o glob fica específico e é avisado", () => {
    const s = suggestPattern([
      apk("YTDLnis-1.9.0-arm64-v8a-github-release.apk"),
      apk("YTDLnis-1.9.0-foss-arm64-v8a-release.apk"),
      apk("YTDLnis-1.9.0-izzy-arm64-v8a-release.apk"),
    ]);
    assert.equal(s.abiAssets["arm64-v8a"], "YTDLnis-*-arm64-v8a-github-release.apk");
    assert.ok(s.notes.some((n) => n.includes("3 variantes")));
  });

  it("sem ABI nos nomes: não inventa, avisa e aponta o maior", () => {
    const s = suggestPattern([apk("app-release.apk", 5), apk("app-release-2.apk", 9)]);
    assert.equal(s.assetPattern, "*.apk");
    assert.equal(s.primary.size, 9);
    assert.ok(s.notes.some((n) => n.includes("nenhum nome revela a ABI")));
  });

  it("assinala builds de debug", () => {
    const s = suggestPattern([apk("app-release.apk"), apk("app-debug.apk")]);
    assert.ok(s.notes.some((n) => n.includes("debug")));
  });

  it("prefere o universal para o download por omissão", () => {
    const s = suggestPattern([
      apk("app-arm64-v8a-release.apk", 30),
      apk("app-universal-release.apk", 90),
    ]);
    assert.equal(s.primary.name, "app-universal-release.apk");
  });

  it("lista vazia não rebenta", () => {
    const s = suggestPattern([]);
    assert.equal(s.primary, null);
    assert.equal(s.assetPattern, null);
  });
});

describe("slugify", () => {
  it("produz um id estável em minúsculas", () => {
    assert.equal(slugify("NewPipe"), "newpipe");
    assert.equal(slugify("Droid-ify"), "droid-ify");
    assert.equal(slugify("NotallyX"), "notallyx");
  });

  it("tira acentos e caracteres estranhos", () => {
    assert.equal(slugify("Ação & Café"), "acao-cafe");
    assert.equal(slugify("  Espaços  "), "espacos");
  });
});
