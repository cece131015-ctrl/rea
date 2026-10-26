import json,subprocess,argparse,hashlib
p=argparse.ArgumentParser();p.add_argument("--left-target",required=True);p.add_argument("--right-target",required=True);p.add_argument("--matching-report",required=True);p.add_argument("--matching-bundle",required=True);args=p.parse_args()
paths=[args.left_target,args.right_target]
receipt=json.load(open(args.matching_report))
for i,path in enumerate(paths):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 assert h.hexdigest()==receipt['sources'][i]['subject']['digest']['sha256']
names=[]
for p in paths:
 r=subprocess.run(['nm','--without-symbol-versions','--dynamic','--no-demangle','--format=posix',p],capture_output=True,text=True,check=True,timeout=20)
 rows=[line.split() for line in r.stdout.splitlines() if line]
 assert all(2<=len(row)<=4 and len(row[1])==1 for row in rows)
 names.append({row[0] for row in rows})
report=receipt;bundle=json.load(open(args.matching_bundle));source=next(e for e in bundle['records'] if e['evidence_id']==report['parent_evidence_id']);matches=[m for m in source['normalized_result']['matches'] if m['state']=='matched'];common=names[0]&names[1]
verified=[];other=[]
for m in matches:
 assert m['basis']=='exact-symbol' and len(m['left'])==len(m['right'])==1
 a=m['left'][0];b=m['right'][0];assert a['name']==b['name']
 (verified if a['name'] in common else other).append(a['name'])
r={'command':['nm','--without-symbol-versions','--dynamic','--no-demangle','--format=posix'],'source_files':paths,'common_raw_dynamic_names':len(common),'matched_correspondences':len(matches),'raw_name_corroborated':len(verified),'provider_only_names':len(other),'provider_only_examples':other[:8]}
print(json.dumps(r,indent=2))
