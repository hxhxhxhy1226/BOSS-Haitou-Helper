"""Export the selected WebGL study as size-specific native extension PNGs."""
import argparse,base64,io,json,re
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter

root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser()
parser.add_argument('rendered_html',type=Path)
args=parser.parse_args()
html=args.rendered_html.read_text(encoding='utf-8')
assert 'data-render-status="passed"' in html, 'Rendering must complete before export'
payload=re.search(r'<script id="result" type="application/json">(.*?)</script>',html,re.S)
images={x['name']:Image.open(io.BytesIO(base64.b64decode(x['image'].split(',')[1]))).convert('RGBA') for x in json.loads(payload.group(1))}
icons=root/'extension'/'icons'
icons.mkdir(parents=True,exist_ok=True)

def fit(source,size,padding):
    cropped=source.crop(source.getchannel('A').getbbox())
    inner=size-padding*2
    scale=inner/max(cropped.size)
    resized=cropped.resize((round(cropped.width*scale),round(cropped.height*scale)),Image.Resampling.LANCZOS)
    icon=Image.new('RGBA',(size,size),(0,0,0,0))
    icon.alpha_composite(resized,((size-resized.width)//2,(size-resized.height)//2))
    return icon

for size,padding in [(16,1),(32,2),(48,3),(128,7)]:
    im=fit(images['small' if size<=32 else 'large'],size,padding)
    im.save(icons/f'icon{size}.png',optimize=True)
master=fit(images['large'],512,24)
master.save(root/'design'/'briefcase'/'icon512.png',optimize=True)

out=root/'artifacts'/'briefcase-final'
out.mkdir(parents=True,exist_ok=True)
preview=Image.new('RGB',(1060,490),'#EDF2F7')
draw=ImageDraw.Draw(preview)
font=lambda s,b=False:ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc' if b else 'C:/Windows/Fonts/msyh.ttc',s)
draw.rounded_rectangle((28,26,398,462),radius=28,fill='#F8FAFC')
hero=master.resize((292,292),Image.Resampling.LANCZOS)
shadow=Image.new('RGBA',preview.size)
ImageDraw.Draw(shadow).ellipse((112,359,328,383),fill=(16,38,62,35))
preview.paste(shadow.filter(ImageFilter.GaussianBlur(12)),(0,0),shadow.filter(ImageFilter.GaussianBlur(12)))
preview.paste(hero,(67,72),hero)
draw=ImageDraw.Draw(preview)
draw.text((106,398),'雾蓝陶瓷 · 公文包',font=font(22,True),fill='#25425B')
draw.text((440,40),'已选方案 07 · 正式图标',font=font(28,True),fill='#183348')
draw.text((442,91),'透明背景 / 提手加粗 / 小尺寸细节优化',font=font(17),fill='#6F8294')
for row,(bg,fg,label) in enumerate([('#FFFFFF','#64788A','浅色工具栏'),('#202C39','#CFDBE7','深色工具栏')]):
    x,y=438,151+row*140
    draw.rounded_rectangle((x,y,1028,y+118),radius=20,fill=bg)
    draw.text((x+22,y+14),label,font=font(15),fill=fg)
    for j,size in enumerate([16,32,48,128]):
        actual=Image.open(icons/f'icon{size}.png').convert('RGBA')
        display=size if size<128 else 56
        actual=actual.resize((display,display),Image.Resampling.LANCZOS)
        px=x+40+j*142;py=y+54+(56-display)//2
        preview.paste(actual,(px,py),actual)
        draw.text((px+display+10,y+75),str(size)+'px',font=font(12),fill=fg)
preview.save(out/'preview.png')
print('Exported 16/32/48/128px icons and 512px master.')
