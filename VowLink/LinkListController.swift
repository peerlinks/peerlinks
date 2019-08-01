//
//  LinkListController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 8/1/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit
import Sodium

class LinkListController : UITableViewController {
    var app: AppDelegate!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        tableView.dataSource = self
    }
    
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return app.identity?.links.count ?? 0
    }
    
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let linkCell = self.tableView.dequeueReusableCell(withIdentifier: "linkCell")!
        if let link = app.identity?.links[indexPath.last ?? 0] {
            let sodium = app.context.sodium
            linkCell.textLabel?.text = link.label ?? sodium.utils.bin2hex(link.issuerPubKey ?? [])
        }
        return linkCell
    }
}
