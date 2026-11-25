"""Package the production LearnHarness server and Android Node runtime."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
from zipfile import ZIP_DEFLATED, ZipFile


ANDROID = Path(__file__).resolve().parent
ROOT = ANDROID.parent
WORK = ROOT / ".android-work"
OUTPUT = ANDROID / "app/build/generated/learnharness"
SERVER = ROOT / ".next/standalone"
NODE_TAG = "24.22.1-0"
NODE_URL = f"https://github.com/fogtape/nodejs-mobile/releases/download/v{NODE_TAG}/nodejs-mobile-android-lite-{NODE_TAG}.zip"
NODE_SHA256 = "87ac319660b9dbff1c3a878d5dec2e15560a42f04d7660c8ddaf87c24627ac82"
NODE_LICENSE_URL = f"https://raw.githubusercontent.com/fogtape/nodejs-mobile/v{NODE_TAG}/LICENSE"
NODE_LICENSE_SHA256 = "c373dabed995013e091b1908996a69a1647ef19d400e6c1fd4b7fb06d8bc0f66"
TARGETS = {
    "arm64-v8a": "aarch64-linux-android",
    "armeabi-v7a": "armv7a-linux-androideabi",
    "x86_64": "x86_64-linux-android",
}


def digest(file, algorithm):
    with file.open("rb") as content:
        return hashlib.file_digest(content, algorithm)


def fetch(url, file, verify):
    if file.is_file() and verify(file):
        return
    temporary = file.with_suffix(".partial")
    try:
        with urllib.request.urlopen(url, timeout=60) as contents, temporary.open("wb") as output:
            shutil.copyfileobj(contents, output)
        if not verify(temporary):
            raise ValueError(f"Archive checksum mismatch: {url}")
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def compile_node_launchers(ndk, abis, out):
    prebuilt = ndk / "toolchains/llvm/prebuilt"
    compiler_name = "clang++.exe" if os.name == "nt" else "clang++"
    compiler = next(prebuilt.glob(f"*/bin/{compiler_name}"), None)
    if compiler is None:
        raise ValueError(f"Android NDK clang not found in {ndk}")
    archive = WORK / "node-android.zip"
    fetch(NODE_URL, archive, lambda file: digest(file, "sha256").hexdigest() == NODE_SHA256)
    with ZipFile(archive) as runtime:
        for header in runtime.namelist():
            if header.startswith("include/node/"):
                runtime.extract(header, WORK / "node")
        for abi in abis:
            destination = out / abi
            destination.mkdir(parents=True, exist_ok=True)
            (destination / "libnode.so").write_bytes(runtime.read(f"bin/{abi}/libnode.so"))
            library_target = "arm-linux-androideabi" if abi == "armeabi-v7a" else TARGETS[abi]
            stdlib = compiler.parent.parent / "sysroot/usr/lib" / library_target / "libc++_shared.so"
            shutil.copyfile(stdlib, destination / stdlib.name)
            subprocess.run(
                [str(compiler), f"--target={TARGETS[abi]}28", "-std=c++20", "-O2",
                 "-fPIE", "-pie", "-Wl,-s,-z,max-page-size=16384",
                 "-Wl,-rpath,$ORIGIN", f"-I{WORK / 'node/include/node'}",
                 str(ANDROID / "node-launcher.cpp"), f"-L{destination}", "-lnode",
                 "-o", str(destination / "liblh-node.so")],
                check=True,
            )


def package_canvas(abis, out, payload):
    if "arm64-v8a" not in abis:
        payload.writestr("native.properties", "")
        return
    package = "@napi-rs/canvas-android-arm64"
    binary = "skia.android-arm64.node"
    location = f"node_modules/{package}"
    locked = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))["packages"]
    lock = locked[location]
    algorithm, expected = lock["integrity"].split("-", 1)
    archive = WORK / f"{package.replace('/', '-')}-{lock['version']}.tgz"
    fetch(lock["resolved"], archive,
          lambda file: base64.b64encode(digest(file, algorithm).digest()).decode() == expected)
    with tarfile.open(archive, "r:gz") as files:
        (out / "arm64-v8a/liblh-canvas.so").write_bytes(files.extractfile(f"package/{binary}").read())
        for member in files.getmembers():
            name = member.name.removeprefix("package/")
            if member.isfile() and (name == "package.json" or name.startswith(("LICENSE", "README"))):
                payload.writestr(f"{location}/{name}", files.extractfile(member).read())
    payload.writestr("native.properties", f"{location}/{binary}=liblh-canvas.so\n")


def package_highlighter(payload):
    # Turbopack relocates Shiki to a hashed package under .next/node_modules,
    # leaving its scoped dependencies under @streamdown/code in npm's tree.
    original = ROOT / "node_modules/@streamdown/code/node_modules/@shikijs"
    for relocated in (SERVER / ".next/node_modules").glob("shiki-*"):
        scope = relocated.relative_to(SERVER) / "node_modules/@shikijs"
        for package in ("core", "engine-javascript", "engine-oniguruma", "langs", "themes", "types"):
            directory = original / package
            if not directory.is_dir():
                directory = ROOT / "node_modules/@shikijs" / package
            if not directory.is_dir():
                raise ValueError(f"Shiki dependency is missing: {package}")
            for file in sorted(directory.rglob("*")):
                name = (scope / package / file.relative_to(directory)).as_posix()
                if file.is_file() and name not in payload.NameToInfo:
                    payload.write(file, name)


def package_payload(abis):
    assets = OUTPUT / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    archive = assets / "runtime.zip"
    with ZipFile(archive, "w", ZIP_DEFLATED, compresslevel=4) as payload:
        for name in (".next", "node_modules", "core-plugins", "public"):
            for file in sorted((SERVER / name).rglob("*")):
                relative = file.relative_to(SERVER)
                if not file.is_file() or file.suffix in {".node", ".exe", ".dll", ".dylib", ".so"}:
                    continue
                if relative.parts[:2] == (".next", "cache") or file.name in {"auth.json", ".env", ".env.local"}:
                    continue
                payload.write(file, relative.as_posix())
        for relative in ("src/agent", "scripts/plugin-loader.cjs", "core-plugins.json", "package.json", "LICENSE"):
            path = SERVER / relative
            for file in sorted(path.rglob("*")) if path.is_dir() else [path]:
                if file.is_file():
                    payload.write(file, file.relative_to(SERVER).as_posix())
        config = json.loads((SERVER / ".next/required-server-files.json").read_text(encoding="utf-8"))
        payload.writestr("android-next-config.json", json.dumps(config["config"]))
        for name in ("engine.cjs", "inspector.cjs"):
            payload.write(ANDROID / name, name)
        package_highlighter(payload)
        package_canvas(abis, OUTPUT / "jniLibs", payload)
    (assets / "runtime.id").write_text(digest(archive, "sha256").hexdigest(), encoding="ascii")
    print(f"Android runtime ready ({archive.stat().st_size / 1048576:.1f} MiB): {archive}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ndk", type=Path, default=os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT"))
    parser.add_argument("--abi", action="append", choices=TARGETS, help="Select one or more ABIs. Defaults to all.")
    args = parser.parse_args()
    if not args.ndk:
        parser.error("provide the Android NDK path via --ndk or ANDROID_NDK_HOME")
    if not (SERVER / "public/plugin-loader.js").is_file() or not (SERVER / ".next/static").is_dir():
        parser.error("run npm run build and node scripts/build-server.mjs first")
    abis = tuple(dict.fromkeys(args.abi or TARGETS))
    WORK.mkdir(exist_ok=True)
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    compile_node_launchers(args.ndk, abis, OUTPUT / "jniLibs")
    package_payload(abis)
    assets = OUTPUT / "assets"
    license_file = WORK / "Node-LICENSE"
    fetch(NODE_LICENSE_URL, license_file, lambda file: digest(file, "sha256").hexdigest() == NODE_LICENSE_SHA256)
    shutil.copyfile(license_file, assets / "Node-LICENSE")
    shutil.copyfile(args.ndk / "NOTICE", assets / "Android-NDK-NOTICE")
    drawable = OUTPUT / "res/drawable-nodpi"
    drawable.mkdir(parents=True)
    shutil.copyfile(ROOT / "build/icon.png", drawable / "ic_learnharness.png")


if __name__ == "__main__":
    main()
