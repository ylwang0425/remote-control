"""Build the public, credential-free Skill ZIP from a closed file list."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent
FILES = ["SKILL.md", "agents/openai.yaml", "scripts/remote-ai.cjs", "scripts/run.ps1", "references/rpc.md"]
VERSION = "1.0.0"

def main():
    source = ROOT / "ai-remote-dispatch"
    actual = sorted(str(p.relative_to(source)).replace("\\", "/") for p in source.rglob("*") if p.is_file())
    if actual != sorted(FILES):
        raise SystemExit("Skill contents differ from the reviewed public allowlist")
    out = ROOT / "dist"
    out.mkdir(exist_ok=True)
    target = out / f"AI-Remote-Dispatch-Skill-{VERSION}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            file = source / name
            if file.is_symlink() or source.resolve() not in file.resolve().parents:
                raise SystemExit("Skill source escapes the package directory")
            info = zipfile.ZipInfo("ai-remote-dispatch/" + name, (2026, 10, 15, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            # The package is identical after Git's Windows CRLF checkout.
            archive.writestr(info, file.read_bytes().replace(b"\r\n", b"\n"))
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() or sorted(archive.namelist()) != sorted("ai-remote-dispatch/" + n for n in FILES):
            raise SystemExit("Skill ZIP failed verification")
    canonical = out / "AI-Remote-Dispatch-Skill.zip"
    canonical.write_bytes(target.read_bytes())
    print(json.dumps({"path": str(target), "bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "files": len(FILES)}))

if __name__ == "__main__":
    main()
