# Source images, not deployed

The site is published with `scp site/* ...`, so nothing in this folder reaches
the server. It holds the uncropped originals the deployed images were made
from, because the crop and the JPEG step are both lossy and otherwise
unrepeatable.

## hero-device-original.jpg -> site/media/device.jpg

1883 x 1412. The home page hero. Remade with:

```
sips -c 1290 1883 --cropOffset 25 0 hero-device-original.jpg --out crop.jpg
sips -Z 1600 crop.jpg --out big.jpg
sips -s format jpeg -s formatOptions 45 big.jpg --out ../site/media/device.jpg
```

The crop is off-centre on purpose: centred, it leaves about 25 px above the
green button, which reads as clipped. The offset gives it room and takes the
difference off the surface below the device instead.
