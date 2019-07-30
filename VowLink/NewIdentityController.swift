//
//  NewIdentityController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class NewIdentityController : UITableViewController {
    @IBOutlet weak var nameField: UITextField!
    @IBOutlet weak var saveButton: UIBarButtonItem!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        saveButton.isEnabled = false
    }
    
    @IBAction func onNameFieldChange(_ sender: Any) {
        saveButton.isEnabled = (nameField.text ?? "").count != 0
    }
    
    @IBAction func saveClicked(_ sender: Any) {
        let name = nameField.text ?? ""
        
        let app = UIApplication.shared.delegate as! AppDelegate
        
        do {
            try app.identityManager.createIdentity(name: name)
        } catch {
            debugPrint("failed to create identity \(error)")
            return
        }

        navigationController?.popViewController(animated: true)
    }
}
