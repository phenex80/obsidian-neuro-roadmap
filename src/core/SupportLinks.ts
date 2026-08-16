/** User-initiated, fixed external links for voluntary project support. */
export const SUPPORT_LINKS = {
  revolut: {
    label: 'Support via Revolut',
    url: 'https://checkout.revolut.com/pay/ae52e66f-c30d-46fc-b7f0-7df89097b3e0',
  },
  kofi: {
    label: 'Support on Ko-fi',
    url: 'https://ko-fi.com/J6C5255736',
  },
} as const;

export type SupportChannel = keyof typeof SUPPORT_LINKS;

export type ExternalUrlOpener = (
  url: string,
  target?: string,
  features?: string,
) => WindowProxy | null;

/** Opens a known funding destination only from an explicit UI action. */
export function openSupportLink(channel: SupportChannel, openExternal: ExternalUrlOpener): void {
  openExternal(SUPPORT_LINKS[channel].url, '_blank', 'noopener,noreferrer');
}
