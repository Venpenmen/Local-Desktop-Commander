import re, os, json
from pathlib import Path
skip={'node_modules','dist','runtime','test-runtime','workspace','logs','.git'}
rx={'credential': re.compile(r'sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'), 'local-path':re.compile(r'[A-Za-z]:[\\/]+(?:Users|Desktop)[\\/]+',re.I), 'tunnel-id':re.compile(r'\btunnel_[0-9a-f]{24,}\b',re.I)}
hits=[]; count=0; size=0
for d,dirs,files in os.walk('.'):
 dirs[:]=[x for x in dirs if x not in skip]
 for name in files:
  p=Path(d)/name
  count+=1; size+=p.stat().st_size
  if name in ['api_key.txt','allowed-root.txt','profile.local.yaml'] or name.endswith(('.dpapi','.bak','.zip','.exe')) or name.startswith('.env'):hits.append(['private-artifact',str(p),0])
  if p.stat().st_size>3000000:continue
  for i,line in enumerate(p.read_text(encoding='utf-8',errors='ignore').splitlines(),1):
   for cat,pattern in rx.items():
    if pattern.search(line):hits.append([cat,str(p),i])
print(json.dumps({'count':count,'bytes':size,'hits':hits},indent=2))
