import sys,pathlib,os,json,hashlib,tarfile,tempfile,shutil,struct

def inventory(root):
 rows=[]
 for p in [root]+sorted(root.rglob('*')):
  rel=p.relative_to(root).as_posix();st=p.lstat();row={'path':rel,'mode':st.st_mode&0o777}
  if p.is_symlink():row.update(kind='link',target=os.readlink(p))
  elif p.is_dir():row.update(kind='directory')
  elif p.is_file():
   h=hashlib.sha256()
   with p.open('rb') as f:
    for b in iter(lambda:f.read(1048576),b''):h.update(b)
   row.update(kind='file',bytes=st.st_size,sha256=h.hexdigest())
  else:raise ValueError('Unsupported fixture entry')
  rows.append(row)
 return rows

def members(archive):
 rows=[];seen=set();links=[]
 with tarfile.open(archive,'r:gz') as t:
  for m in t.getmembers():
   name=m.name;p=pathlib.PurePosixPath(name)
   if p.is_absolute() or '..' in p.parts or name in seen:raise ValueError('Unsafe or duplicate archive member')
   seen.add(name)
   if not (m.isdir() or m.isfile() or m.issym()):raise ValueError('Unsupported archive type')
   if m.issym():links.append(name)
   rows.append({'path':name,'kind':'directory' if m.isdir() else 'link' if m.issym() else 'file','bytes':m.size,'target':m.linkname if m.issym() else None})
  if any(n.startswith(link+'/') for link in links for n in seen):raise ValueError('Archive child traverses symlink')
  metadata=[]
  for m in t.getmembers():
   if not m.isfile() or not pathlib.PurePosixPath(m.name).name.startswith('._'):continue
   data=t.extractfile(m).read();target=str(pathlib.PurePosixPath(m.name).with_name(pathlib.PurePosixPath(m.name).name[2:]))
   if len(data)<26 or struct.unpack('>II',data[:8])!=(0x00051607,0x00020000) or target not in seen:raise ValueError('Unmapped AppleDouble member')
   count=struct.unpack('>H',data[24:26])[0];end=26+12*count
   if end>len(data):raise ValueError('Truncated AppleDouble table')
   extents=[]
   for i in range(count):
    eid,at,n=struct.unpack('>III',data[26+12*i:38+12*i])
    if at<end or at+n>len(data) or any(at<b and a<at+n for a,b in extents):raise ValueError('Invalid AppleDouble extent')
    extents.append((at,at+n))
   metadata.append({'path':m.name,'target':target,'entries':count})
 return {'members':rows,'appleDouble':metadata}

def archive(root,destination):
 before=inventory(root)
 with tarfile.open(destination,'x:gz',format=tarfile.PAX_FORMAT,dereference=False) as t:
  for row in before:
   t.inodes.clear();t.add(root/row['path'],arcname=row['path'],recursive=False)
 catalog=members(destination);verify=pathlib.Path(tempfile.mkdtemp(prefix='p25-extracted-',dir=destination.parent))
 with tarfile.open(destination,'r:gz') as t:t.extractall(verify)
 after=inventory(root);extracted=inventory(verify)
 record={'before':before,'after':after,'extracted':extracted,**catalog,'extractionRoot':str(verify),'verified':before==after==extracted}
 evidence=destination.with_suffix(destination.suffix+'.inventory.json');evidence.write_text(json.dumps(record,indent=2))
 if not record['verified']:raise ValueError('Fixture archive differs; original and extraction retained')
 shutil.rmtree(verify)
 h=hashlib.sha256(destination.read_bytes()).hexdigest()
 return {'archive':str(destination),'sha256':h,'inventory':str(evidence),'entries':len(before),'verified':True,'appleDoubleEntries':len(catalog['appleDouble'])}
if __name__=='__main__':print(json.dumps(archive(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))))
