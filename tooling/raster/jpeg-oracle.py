# Independent Pillow/libjpeg-turbo decoder, no Sharp or application CP code.
import pathlib,json,hashlib,PIL
from PIL import Image,features,_imaging
root=pathlib.Path(__file__).resolve().parents[2]
source=root/'tests/raster/fixtures/color.jpg'
image=Image.open(source).convert('RGBA')
print(json.dumps({'method':'Pillow11.3.0 public Image.open().convert(RGBA), independently installed libjpeg-turbo; no Sharp/app calls.','pillow':PIL.__version__,'jpeg':features.version('jpg'),'libjpegTurbo':features.version_feature('libjpeg_turbo'),'extensionSHA256':hashlib.sha256(pathlib.Path(_imaging.__file__).read_bytes()).hexdigest(),'file':'color.jpg','encodedSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'width':image.width,'height':image.height,'expectedRGBA':list(image.tobytes())},indent=2))
