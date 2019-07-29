//
//  ViewController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/29/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class ViewController: UIViewController {
    var p2p: PeerToPeer = PeerToPeer(serviceType: "com-vowlink")
    
    override func viewDidLoad() {
        super.viewDidLoad()
        // Do any additional setup after loading the view.
    }


    @IBAction func buttonClicked(_ sender: Any) {
        p2p.broadcast()
    }
}

