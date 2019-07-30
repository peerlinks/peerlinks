//
//  LinkRequestController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class LinkRequestController : UIViewController {
    @IBOutlet weak var imageView: UIImageView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = UIApplication.shared.delegate as! AppDelegate
        let identity = app.identity!
        
        let req = Proto_LinkRequest.with { (req) in
            req.trusteePubKey = Data(identity.publicKey)
            req.desiredDisplayName = identity.name
        }
        let binary = try! req.serializedData()
        
        let filter = CIFilter(name: "CIQRCodeGenerator")
        
        filter?.setValue(binary, forKey: "inputMessage")
        filter?.setValue("Q", forKey: "inputCorrectionLevel")
        
        guard let image = filter?.outputImage else {
            debugPrint("Could not generate image")
            return;
        }
        
        let scale = view.frame.size.width / image.extent.width

        let transform = CGAffineTransform(scaleX: scale, y: scale)
        
        let qr = image.transformed(by: transform)
        imageView.image = UIImage(ciImage: qr)
    }
}
