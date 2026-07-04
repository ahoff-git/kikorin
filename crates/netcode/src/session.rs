/// WASM-only peer session using wasm-peers for WebRTC data channels.
/// TypeScript handles signaling/handshaking; Rust owns the data channel communication.
///
/// Architecture:
///   - TypeScript generates a session ID and calls `connect(session_id, signaling_url)`
///   - wasm-peers connects to the signaling server and negotiates WebRTC with other peers
///   - Inbound messages are queued internally; `drain_inbound()` is called each tick
///   - Outbound deltas are sent via `broadcast()` or `send_to()`

#[cfg(target_arch = "wasm32")]
mod inner {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;
    use wasm_peers::many_to_many::NetworkManager;
    use wasm_peers::{ConnectionType, SessionId, UserId};

    // Peer list stores (display-string, UserId) so we can look up by string for send_to
    // and use the native UserId for send_message.
    type PeerList = Rc<RefCell<Vec<(String, UserId)>>>;
    pub type InboundQueue = Rc<RefCell<VecDeque<(String, Vec<u8>)>>>;

    pub struct PeerSession {
        session: Option<NetworkManager>,
        inbound: InboundQueue,
        connected_peers: PeerList,
    }

    impl PeerSession {
        pub fn new() -> Self {
            Self {
                session: None,
                inbound: Rc::new(RefCell::new(VecDeque::new())),
                connected_peers: Rc::new(RefCell::new(Vec::new())),
            }
        }

        /// Initialize the WebRTC session.
        /// TypeScript passes in a session ID (shared with all peers in the room) and the
        /// URL of the signaling server.
        pub fn connect(&mut self, session_id: &str, signaling_url: &str) {
            let inbound = Rc::clone(&self.inbound);
            let peers = Rc::clone(&self.connected_peers);

            let mut manager = NetworkManager::new(
                signaling_url,
                SessionId::new(session_id.to_string()),
                ConnectionType::Stun {
                    urls: "stun:stun.l.google.com:19302".to_string(),
                },
            )
            .expect("failed to create wasm-peers session");

            let peers_open = Rc::clone(&peers);
            let on_open = move |user_id: UserId| {
                peers_open.borrow_mut().push((user_id.to_string(), user_id));
            };

            let on_message = move |user_id: UserId, msg: String| {
                if let Ok(bytes) = hex_decode(&msg) {
                    inbound.borrow_mut().push_back((user_id.to_string(), bytes));
                }
            };

            manager.start(on_open, on_message);
            self.session = Some(manager);
        }

        pub fn drain_inbound(&self) -> Vec<(String, Vec<u8>)> {
            self.inbound.borrow_mut().drain(..).collect()
        }

        pub fn broadcast(&self, payload: &[u8]) {
            let Some(session) = &self.session else { return };
            let encoded = hex_encode(payload);
            for (_, user_id) in self.connected_peers.borrow().iter() {
                let _ = session.send_message(*user_id, &encoded);
            }
        }

        pub fn send_to(&self, peer_id: &str, payload: &[u8]) {
            let Some(session) = &self.session else { return };
            let encoded = hex_encode(payload);
            let user_id = self
                .connected_peers
                .borrow()
                .iter()
                .find(|(id, _)| id == peer_id)
                .map(|(_, uid)| *uid);
            if let Some(uid) = user_id {
                let _ = session.send_message(uid, &encoded);
            }
        }

        pub fn peers(&self) -> Vec<String> {
            self.connected_peers
                .borrow()
                .iter()
                .map(|(id, _)| id.clone())
                .collect()
        }

        pub fn is_connected(&self) -> bool {
            !self.connected_peers.borrow().is_empty()
        }
    }

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
        if s.len() % 2 != 0 {
            return Err(());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
            .collect()
    }
}

#[cfg(target_arch = "wasm32")]
pub use inner::PeerSession;

/// Native stub — used for tests and non-WASM compilation.
#[cfg(not(target_arch = "wasm32"))]
pub struct PeerSession;

#[cfg(not(target_arch = "wasm32"))]
impl PeerSession {
    pub fn new() -> Self {
        Self
    }
    pub fn connect(&mut self, _session_id: &str, _signaling_url: &str) {}
    pub fn drain_inbound(&self) -> Vec<(String, Vec<u8>)> {
        vec![]
    }
    pub fn broadcast(&self, _payload: &[u8]) {}
    pub fn send_to(&self, _peer_id: &str, _payload: &[u8]) {}
    pub fn peers(&self) -> Vec<String> {
        vec![]
    }
    pub fn is_connected(&self) -> bool {
        false
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for PeerSession {
    fn default() -> Self {
        Self::new()
    }
}
