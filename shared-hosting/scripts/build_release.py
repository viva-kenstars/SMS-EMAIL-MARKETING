#!/usr/bin/env python3
"""Generate deployment assets from editable source; no credentials or remote calls."""
from pathlib import Path
import hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(root/'scripts/build_templates.py')],check=True)
assets=root/'public/assets'
manifest={p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest()[:16],'bytes':p.stat().st_size} for p in sorted(assets.iterdir()) if p.suffix in ['.js','.css']}
(assets/'asset-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Release assets generated. Upload private/ and public/ together; preserve config.php and vendor/.')
