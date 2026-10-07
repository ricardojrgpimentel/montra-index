// APK inspection via the Android SDK build-tools.
//
// We deliberately do not parse the binary AndroidManifest or the APK signing block
// ourselves: aapt2/apksigner are the reference implementations, they are already on
// every Android developer machine and on CI via android-actions/setup-android, and
// getting versionCode or the signing certificate wrong would poison the whole index.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { exists, hexToColon, log } from "./util.mjs";

const execFileAsync = promisify(execFile);

const JAVA_HOME_CANDIDATES = [
  process.env.JAVA_HOME,
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home",
  "/Library/Java/JavaVirtualMachines/*/Contents/Home",
  path.join(os.homedir(), ".sdkman/candidates/java/current"),
  "/usr/lib/jvm/default-java",
].filter(Boolean);

const SDK_CANDIDATES = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(os.homedir(), "Library/Android/sdk"),
  path.join(os.homedir(), "Android/Sdk"),
  "/usr/local/lib/android/sdk",
  "/opt/android-sdk",
].filter(Boolean);

let toolsCache;

async function findInSdk() {
  const found = { aapt2: null, apksigner: null, sdkRoot: null };
  for (const root of SDK_CANDIDATES) {
    try {
      await fs.access(root);
    } catch {
      continue;
    }
    found.sdkRoot ??= root;
    const buildToolsDir = path.join(root, "build-tools");
    let versions = [];
    try {
      versions = (await fs.readdir(buildToolsDir)).sort(compareVersions).reverse();
    } catch {
      /* no build-tools */
    }
    for (const version of versions) {
      const aapt2 = path.join(buildToolsDir, version, "aapt2");
      const apksigner = path.join(buildToolsDir, version, "apksigner");
      if (!found.aapt2 && (await exists(aapt2))) found.aapt2 = aapt2;
      if (!found.apksigner && (await exists(apksigner))) found.apksigner = apksigner;
    }
    if (found.aapt2 && found.apksigner) break;
  }
  return found;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * apksigner is a shell wrapper around `java -jar apksigner.jar`, so it needs a
 * JRE. Plenty of machines (and CI images) have the Android SDK but no `java` on
 * PATH, which makes it fail with a message that is easy to miss. We resolve a JDK
 * ourselves and hand it to the child process.
 */
async function findJavaHome() {
  for (const candidate of JAVA_HOME_CANDIDATES) {
    if (candidate.includes("*")) {
      const dir = path.dirname(candidate);
      const base = path.basename(candidate);
      try {
        const matches = (await fs.readdir(dir)).filter((entry) => base.replace("*", "") === "" || true);
        for (const match of matches) {
          const full = path.join(dir, match);
          if (await exists(path.join(full, "bin", "java"))) return full;
        }
      } catch {
        /* ignore */
      }
      continue;
    }
    if (await exists(path.join(candidate, "bin", "java"))) return candidate;
  }
  try {
    const { stdout } = await execFileAsync("/usr/libexec/java_home", [], { timeout: 5000 });
    const home = stdout.trim();
    if (home && (await exists(path.join(home, "bin", "java")))) return home;
  } catch {
    /* not macOS or no JDK */
  }
  return null;
}

export async function findApkTools({ required = true } = {}) {
  if (toolsCache) return toolsCache;
  const fromSdk = await findInSdk();
  const resolve = async (envVar, name) => {
    if (process.env[envVar]) return process.env[envVar];
    if (fromSdk[name]) return fromSdk[name];
    try {
      const { stdout } = await execFileAsync("which", [name], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const tools = {
    aapt2: await resolve("AAPT2", "aapt2"),
    apksigner: await resolve("APKSIGNER", "apksigner"),
    javaHome: await findJavaHome(),
    sdkRoot: fromSdk.sdkRoot,
  };
  if (required && !tools.aapt2) {
    throw new Error(
      "aapt2 não encontrado. Instala as Android SDK build-tools (sdkmanager 'build-tools;35.0.0') " +
        "ou define ANDROID_HOME / AAPT2.",
    );
  }
  if (!tools.apksigner) {
    log.warn("apksigner não encontrado: os fingerprints de certificado ficam por verificar nesta build");
  } else if (!tools.javaHome) {
    log.warn(
      "apksigner encontrado mas nenhum JDK: define JAVA_HOME, senão os fingerprints de certificado ficam nulos",
    );
  }
  toolsCache = tools;
  return tools;
}

/** aapt2 dump badging -> the handful of fields we index. */
export async function inspectApk(apkPath, { tools } = {}) {
  const { aapt2, apksigner, javaHome } = tools ?? (await findApkTools());
  const { stdout } = await execFileAsync(aapt2, ["dump", "badging", apkPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const info = {
    packageName: null,
    versionCode: null,
    versionName: null,
    minSdk: null,
    targetSdk: null,
    compileSdk: null,
    label: null,
    nativeAbis: [],
    signingCertSha256: null,
  };
  for (const line of stdout.split("\n")) {
    const val = (re) => {
      const m = line.match(re);
      return m ? m[1] : null;
    };
    if (line.startsWith("package:")) {
      info.packageName = val(/name='([^']+)'/);
      info.versionCode = Number(val(/versionCode='([^']+)'/)) || null;
      info.versionName = val(/versionName='([^']*)'/) ?? null;
    } else if (line.startsWith("sdkVersion:")) {
      info.minSdk = Number(val(/'([^']+)'/)) || null;
    } else if (line.startsWith("targetSdkVersion:")) {
      info.targetSdk = Number(val(/'([^']+)'/)) || null;
    } else if (line.startsWith("compileSdkVersion:")) {
      info.compileSdk = Number(val(/'([^']+)'/)) || null;
    } else if (line.startsWith("application-label:")) {
      info.label = val(/:'?(.*?)'?$/);
    } else if (line.startsWith("native-code:")) {
      info.nativeAbis = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    }
  }

  if (apksigner) {
    try {
      const { stdout: signerOut } = await execFileAsync(
        apksigner,
        ["verify", "--print-certs", "--verbose", apkPath],
        {
          maxBuffer: 16 * 1024 * 1024,
          env: javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env,
        },
      );
      const signers = [...signerOut.matchAll(/Signer #(\d+) certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/g)];
      if (signers.length === 0) {
        // Older apksigner prints the digest in a different shape.
        const alt = signerOut.match(/certificate SHA-256 digest:\s*([0-9a-fA-F:]+)/);
        if (alt) info.signingCertSha256 = hexToColon(alt[1].replace(/:/g, ""));
      } else {
        // Multiple signers means signing lineage / rotation: the first is the current signer.
        info.signingCertSha256 = hexToColon(signers[0][2].replace(/:/g, ""));
        info.signerCount = signers.length;
      }
    } catch (error) {
      info.signingCertSha256 = null;
      info.signerError = String(error?.stderr ?? error?.message ?? error).slice(0, 300);
    }
  }
  return info;
}
