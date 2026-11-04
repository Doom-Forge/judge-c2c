import {
  Miniflare as NativeMiniflare,
  convertV4MiniflareOptions,
  type V4MiniflareOptions,
} from 'miniflare';

// Keep the fixtures on their existing configuration contract while using the
// fixed synchronous binding bridge in Miniflare 5 (workers-sdk#15552).
export class Miniflare extends NativeMiniflare {
  constructor(options: V4MiniflareOptions) {
    super(convertV4MiniflareOptions(options));
  }
}
