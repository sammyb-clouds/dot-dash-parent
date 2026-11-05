import Foundation
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil)!
let n = CGImageSourceGetCount(src)
let props = CGImageSourceCopyProperties(src, nil) as! [CFString: Any]
let gp = props[kCGImagePropertyGIFDictionary] as? [CFString: Any]
print("frames: \(n)  loop: \(gp?[kCGImagePropertyGIFLoopCount] ?? "?")")
var total = 0.0
for i in 0..<n {
    let p = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as! [CFString: Any]
    let g = p[kCGImagePropertyGIFDictionary] as! [CFString: Any]
    let d = (g[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? 0
    total += d
    if a.count > 2, let want = Int(a[2]), i == want {
        let img = CGImageSourceCreateImageAtIndex(src, i, nil)!
        let out = URL(fileURLWithPath: a[3])
        let dst = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dst, img, nil); CGImageDestinationFinalize(dst)
        print("dumped frame \(i) (\(img.width)x\(img.height)) -> \(a[3])")
    }
}
print(String(format: "total %.2f s", total))
