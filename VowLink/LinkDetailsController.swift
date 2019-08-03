//
//  LinkDetailsController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class LinkDetailsController : UIViewController {
    @IBOutlet weak var descriptionLabel: UILabel!
    @IBOutlet weak var subscribeButton: UIButton!
    
    var link: Link? = nil
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        descriptionLabel.text = link?.label
        subscribeButton.isEnabled = link?.issuerPubKey != nil
    }

    @IBAction func subscribeClicked(_ sender: Any) {
        let app = (UIApplication.shared.delegate as! AppDelegate)
        
        guard let publicKey = link?.issuerPubKey else {
            debugPrint("no issuer public key!")
            return
        }
        
        do {
            try app.channels.add(publicKey: publicKey, label: descriptionLabel.text)
            
            let alert = UIAlertController(title: "Subscribed", message: "Successfully subscribed to channel", preferredStyle: .alert)
            
            alert.addAction(UIAlertAction(title: "Ok", style: .default, handler: nil))
            
            present(alert, animated: true, completion: nil)
        } catch {
            debugPrint("failed to subscribe \(error)")
        }
    }
}
