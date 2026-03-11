export function truncateAddress(
  address: string,
  leading = 6,
  trailing = 4,
) {
  if (address.length <= leading + trailing) {
    return address;
  }

  return `${address.slice(0, leading)}...${address.slice(-trailing)}`;
}
