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
    var selectedLink: Link? = nil
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        tableView.dataSource = self
    }
    
    func linkAt(indexPath: IndexPath) -> Link? {
        return app.identity?.links[indexPath.last ?? 0]
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let details = segue.destination as? LinkDetailsController {
            details.link = selectedLink
        }
        super.prepare(for: segue, sender: sender)
    }
    
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return app.identity?.links.count ?? 0
    }
    
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let linkCell = self.tableView.dequeueReusableCell(withIdentifier: "linkCell")!
        guard let link = linkAt(indexPath: indexPath) else {
            return linkCell
        }
        
        let sodium = app.context.sodium
        linkCell.textLabel?.text = link.label ?? sodium.utils.bin2hex(link.issuerPubKey ?? [])
        
        return linkCell
    }
    
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        selectedLink = linkAt(indexPath: indexPath)
        performSegue(withIdentifier: "toLinkDetails", sender: self)
    }
}
