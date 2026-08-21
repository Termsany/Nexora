using System.Net.NetworkInformation;
using System.Net.Sockets;
using Nexora.Agent.Models;

namespace Nexora.Agent.Collectors;

public sealed class NetworkCollector
{
    public IReadOnlyList<NetworkInventory> Collect() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(item => item.OperationalStatus == OperationalStatus.Up && item.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .SelectMany(item =>
        {
            var properties = item.GetIPProperties();
            var addresses = properties.UnicastAddresses.Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork && !address.Address.ToString().StartsWith("169.254.")).ToArray();
            var gateway = properties.GatewayAddresses.FirstOrDefault(value => value.Address.AddressFamily == AddressFamily.InterNetwork)?.Address.ToString() ?? "";
            var dns = properties.DnsAddresses.Where(value => value.AddressFamily == AddressFamily.InterNetwork).Select(value => value.ToString()).ToArray();
            return addresses.Select(address => new NetworkInventory(item.Name, item.NetworkInterfaceType.ToString(), address.Address.ToString(), item.GetPhysicalAddress().ToString(), gateway, dns));
        }).ToArray();
}
