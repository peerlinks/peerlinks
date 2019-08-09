import UIKit

class ChannelListController : UIViewController, UITableViewDataSource {
    var network: NetworkManager!
    var channelList: ChannelList!
    @IBOutlet weak var tableView: UITableView!
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        let app = (UIApplication.shared.delegate as! AppDelegate)
        network = app.network
        channelList = network.channelList
        
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
        let name = network.queue.sync {
            return channelList.channels[indexPath.row].name
        }
        let cell = tableView.dequeueReusableCell(withIdentifier: "channelCell")!
        cell.textLabel?.text = name
        return cell
    }

    func reloadChannels() {
        tableView.reloadData()
    }
}
