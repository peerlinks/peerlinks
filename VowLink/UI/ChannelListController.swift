import UIKit
import Sodium

class ChannelListController : UIViewController, UITableViewDataSource, ChannelPeersDelegate {
    var network: NetworkManager!
    var channelList: ChannelList!
    @IBOutlet weak var tableView: UITableView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        network = app.network
        channelList = network.channelList
        
        network.channelPeersDelegate = self
        
        tableView.dataSource = self
    }
    
    override func prepare(for segue: UIStoryboardSegue, sender: Any?) {
        if let cell = sender as? UITableViewCell,
            let channelController = segue.destination as? ChannelController {
            let index = tableView.indexPath(for: cell)!
            
            network.queue.sync {
                channelController.channel = channelList.channels[index.row]
            }
        }
    }
    
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return network.queue.sync {
            return channelList.channels.count
        }
    }
    
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let name: String = network.queue.sync {
            let channel = channelList.channels[indexPath.row]
            let peers = network.peerCount(for: channel.channelID)
            
            return "\(channel.name) [\(peers)]"
        }
        let cell = tableView.dequeueReusableCell(withIdentifier: "channelCell")!
        cell.textLabel?.text = name
        return cell
    }

    func reloadChannels() {
        tableView.reloadData()
    }
    
    // MARK: ChannelPeersDelegate
    
    func channelPeers(updatedForChannel channelID: Bytes) {
        DispatchQueue.main.async {
            self.reloadChannels()
        }
    }
}
