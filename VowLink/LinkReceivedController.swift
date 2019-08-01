//
//  ReceivedLinkController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class LinkReceivedController : ViewController {
    @IBOutlet weak var saveButton: UIBarButtonItem!
    @IBOutlet weak var descriptionField: UITextField!
    
    var link: Link? = nil
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        saveButton.isEnabled = false
    }
    
    @IBAction func descriptionChanged(_ sender: Any) {
        saveButton.isEnabled = !(descriptionField.text?.isEmpty ?? false)
    }
    
    @IBAction func saveClicked(_ sender: Any) {
        if !saveButton.isEnabled {
            return
        }
        
        link?.label = descriptionField.text
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        do {
            if let link = link {
                try app.identity?.addLink(link)
            }
        } catch {
            // TODO(indutny): display
            debugPrint("failed to save identity \(error)")
        }
        
        navigationController?.popViewController(animated: true)
    }
}
