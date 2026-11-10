import struct
def lees(p, enc='latin1'):
    f=open(p,'rb'); h=f.read(32); n,hl,rl=struct.unpack('<xxxxIHH',h[:12]); velden=[]
    while True:
        d=f.read(32)
        if d[0]==0x0D: break
        velden.append((d[:11].split(b'\0')[0].decode(), chr(d[11]), d[16]))
    f.seek(hl); rijen=[]
    for _ in range(n):
        r=f.read(rl)
        if not r or r[0:1]==b'*': continue
        pos=1; o={}
        for nm,t,l in velden: o[nm]=r[pos:pos+l].decode(enc,'replace').strip(); pos+=l
        rijen.append(o)
    return velden,rijen
