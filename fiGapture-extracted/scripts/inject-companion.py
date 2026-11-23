#!/usr/bin/env python3
"""Injects src/content/companion.src.js into src/content/toolbar.js at the data-fs-ready hook."""
import re,sys,os
root=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
t=os.path.join(root,'src/content/toolbar.js'); c=os.path.join(root,'src/content/companion.src.js')
s=open(t).read(); code=open(c).read()
s=re.sub(r'/\*FGC-START\*/.*?/\*FGC-END\*/','',s,flags=re.S)
hook='document.getElementById("__figma_capture_ext_toolbar__")?.setAttribute("data-fs-ready","1");'
assert hook in s,'hook not found'
s=s.replace(hook,hook+'/*FGC-START*/'+code+'\n/*FGC-END*/',1)
open(t,'w').write(s); print('injected',len(code),'bytes')
