#!/usr/bin/env python3
"""Generate deployment assets from editable source; no credentials or remote calls."""
from pathlib import Path
import hashlib,json,subprocess,sys
root=Path(__file__).resolve().parents[1]
for script in ['build_templates.py','build_workspace.py']:
 subprocess.run([sys.executable,str(root/'scripts'/script)],check=True)
assets=root/'public/assets'
manifest={p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest()[:16],'bytes':p.stat().st_size} for p in sorted(assets.iterdir()) if p.suffix in ['.js','.css']}
(assets/'asset-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Release generated. Apply additive migrations, upload private/ and public/ together, preserve config.php and vendor/.')
