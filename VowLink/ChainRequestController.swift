import UIKit
import Sodium

class ChainRequestController : UIViewController, ChainNotificationDelegate {
    @IBOutlet weak var imageView: UIImageView!
    var sodium: Sodium!
    var boxPublicKey: Bytes?
    var boxSecretKey: Bytes?
    var chain: Chain? = nil
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = UIApplication.shared.delegate as! AppDelegate
        let identity = app.identity!
        
        sodium = app.context.sodium
        
        let keyPair = sodium.box.keyPair()!
        
        boxPublicKey = keyPair.publicKey
        boxSecretKey = keyPair.secretKey
        
        let req = Proto_LinkRequest.with { (req) in
            req.peerID = app.p2p.localID.displayName
            req.trusteePubKey = Data(identity.publicKey)

            req.boxPubKey = Data(keyPair.publicKey)
        }
        let binary = try! req.serializedData()
        let b64 = app.context.sodium.utils.bin2base64(Bytes(binary))!
        let uri = "vow-link://link-request/\(b64)"
        
        let filter = CIFilter(name: "CIQRCodeGenerator")
        
        filter?.setValue(Data(uri.bytes), forKey: "inputMessage")
        filter?.setValue("Q", forKey: "inputCorrectionLevel")
        
        guard let image = filter?.outputImage else {
            debugPrint("Could not generate image")
            return;
        }
        
        let scale = view.frame.size.width / image.extent.width

        let transform = CGAffineTransform(scaleX: scale, y: scale)
        
        let qr = image.transformed(by: transform)
        imageView.image = UIImage(ciImage: qr)
        
        app.chainDelegate = self
    }
    
    deinit {
        if var secretKey = boxSecretKey {
            sodium.utils.zero(&secretKey)
        }
    }

    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let received = segue.destination as? ChainReceivedController {
            received.chain = chain
        }
        super.prepare(for: segue, sender: sender)
    }
    
    // MARK: ChainNotificationDelegate
    
    func chain(received chain: Chain) {
        self.chain = chain
        performSegue(withIdentifier: "toReceivedLink", sender: self)
    }
}
