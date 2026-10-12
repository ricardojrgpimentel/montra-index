// Tests do parsing de `aapt2 dump badging`. Correm sem o Android SDK instalado:
// o que se testa aqui é a decisão do que entra no índice, não o aapt2.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBadging } from "./apk.mjs";

describe("parseBadging: permissões", () => {
  it("lê uma linha uses-permission normal", () => {
    const info = parseBadging("uses-permission: name='android.permission.INTERNET'\n");
    assert.deepEqual(info.permissions, ["android.permission.INTERNET"]);
  });

  it("junta uses-permission-sdk-23 à mesma lista", () => {
    const info = parseBadging(
      [
        "uses-permission: name='android.permission.INTERNET'",
        "uses-permission-sdk-23: name='android.permission.ACCESS_FINE_LOCATION'",
        "",
      ].join("\n"),
    );
    assert.deepEqual(info.permissions, ["android.permission.ACCESS_FINE_LOCATION", "android.permission.INTERNET"]);
  });

  it("não repete nomes e ordena alfabeticamente", () => {
    const info = parseBadging(
      [
        "uses-permission: name='android.permission.INTERNET'",
        "uses-permission: name='android.permission.CAMERA'",
        "uses-permission-sdk-23: name='android.permission.INTERNET'",
        "uses-permission: name='android.permission.CAMERA'",
      ].join("\n"),
    );
    assert.deepEqual(info.permissions, ["android.permission.CAMERA", "android.permission.INTERNET"]);
  });

  it("ignora o maxSdkVersion da linha", () => {
    const info = parseBadging("uses-permission: name='android.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='32'\n");
    assert.deepEqual(info.permissions, ["android.permission.WRITE_EXTERNAL_STORAGE"]);
  });

  it("sem permissões declaradas devolve uma lista vazia", () => {
    const info = parseBadging("package: name='org.exemplo' versionCode='7' versionName='1.0'\n");
    assert.deepEqual(info.permissions, []);
  });

  it("não deixa entrar nomes com espaços ou caracteres estranhos", () => {
    const info = parseBadging(
      [
        "uses-permission: name='android.permission.INTER NET'",
        "uses-permission: name='android permission.INTERNET'",
        "uses-permission: name='-android.permission.INTERNET'",
        "uses-permission: name=\"android.permission.INTERNET\"",
        "uses-permission: name='android.permission.INTERNET;rm -rf'",
        "uses-permission: name='android.permission.INTERNET'",
      ].join("\n"),
    );
    assert.deepEqual(info.permissions, ["android.permission.INTERNET"]);
  });

  it("não confunde as permissões implícitas com as declaradas", () => {
    const info = parseBadging(
      [
        "uses-implied-permission: name='android.permission.CAMERA' reason='requested WRITE_EXTERNAL_STORAGE'",
        "uses-permission: name='android.permission.INTERNET'",
      ].join("\n"),
    );
    assert.deepEqual(info.permissions, ["android.permission.INTERNET"]);
  });
});

describe("parseBadging: os campos que já existiam", () => {
  it("continua a ler o package, o versionCode e os SDKs", () => {
    const info = parseBadging(
      [
        "package: name='org.schabi.newpipe' versionCode='1015' versionName='0.29.1'",
        "sdkVersion:'23'",
        "targetSdkVersion:'35'",
        "application-label:'NewPipe'",
        "native-code: 'arm64-v8a' 'armeabi-v7a'",
        "",
      ].join("\n"),
    );
    assert.equal(info.packageName, "org.schabi.newpipe");
    assert.equal(info.versionCode, 1015);
    assert.equal(info.versionName, "0.29.1");
    assert.equal(info.minSdk, 23);
    assert.equal(info.targetSdk, 35);
    assert.deepEqual(info.nativeAbis, ["arm64-v8a", "armeabi-v7a"]);
  });
});
