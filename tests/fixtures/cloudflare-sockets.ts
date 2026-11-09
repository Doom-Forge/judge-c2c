type SocketFixture = {
	opened: Promise<SocketFixture>;
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	close(): void;
};
let factory: (() => SocketFixture) | undefined;
export function setSocketFactory(next: (() => SocketFixture) | undefined) {
	factory = next;
}
export function connect(): SocketFixture {
	if (!factory) throw new Error("SMTP_SOCKET_FIXTURE_NOT_CONFIGURED");
	return factory();
}
