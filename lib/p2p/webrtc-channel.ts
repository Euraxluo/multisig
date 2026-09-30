/**
 * WebRTC DataChannel 点对点直连通信管理器
 * 适用于密码学组织核心管理层之间的零服务器、低延迟、抗审查直连信道
 */

export interface PeerMessage<T = any> {
  type: string;
  sender: string;
  timestamp: number;
  payload: T;
  signature?: string;
}

export type MessageHandler = (msg: PeerMessage) => void;

export class WebRTCChannelManager {
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private messageHandlers: Set<MessageHandler> = new Set();
  public readonly localPeerId: string;

  constructor(localPeerId: string) {
    this.localPeerId = localPeerId;
  }

  /**
   * 注册收到点对点消息的监听器
   */
  public onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * 创建发往目标成员的点对点连接与 DataChannel (Offer 方)
   */
  public async createPeerOffer(
    remotePeerId: string,
    onLocalSignal: (signal: any) => void
  ): Promise<RTCDataChannel> {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    this.peerConnections.set(remotePeerId, pc);

    // 建立有序低延迟的 DataChannel
    const dc = pc.createDataChannel(`crypto-org-${this.localPeerId}-${remotePeerId}`, {
      ordered: true,
      maxRetransmits: 5,
    });

    this.setupDataChannel(remotePeerId, dc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        onLocalSignal({
          type: "ICE_CANDIDATE",
          from: this.localPeerId,
          to: remotePeerId,
          candidate: event.candidate,
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    onLocalSignal({
      type: "SDP_OFFER",
      from: this.localPeerId,
      to: remotePeerId,
      sdp: offer,
    });

    return dc;
  }

  /**
   * 响应远端成员发来的 Offer (Answer 方)
   */
  public async handleRemoteOffer(
    remotePeerId: string,
    offerSdp: RTCSessionDescriptionInit,
    onLocalSignal: (signal: any) => void
  ): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    this.peerConnections.set(remotePeerId, pc);

    pc.ondatachannel = (event) => {
      this.setupDataChannel(remotePeerId, event.channel);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        onLocalSignal({
          type: "ICE_CANDIDATE",
          from: this.localPeerId,
          to: remotePeerId,
          candidate: event.candidate,
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    onLocalSignal({
      type: "SDP_ANSWER",
      from: this.localPeerId,
      to: remotePeerId,
      sdp: answer,
    });
  }

  /**
   * 广播消息给所有当前连接的活跃成员
   */
  public broadcast<T = any>(type: string, payload: T): void {
    const message: PeerMessage<T> = {
      type,
      sender: this.localPeerId,
      timestamp: Date.now(),
      payload,
    };
    const raw = JSON.stringify(message);

    this.dataChannels.forEach((dc, peerId) => {
      if (dc.readyState === "open") {
        dc.send(raw);
      }
    });
  }

  /**
   * 单播发送给特定成员 (例如 DKG 私钥分片传输)
   */
  public sendTo<T = any>(remotePeerId: string, type: string, payload: T): boolean {
    const dc = this.dataChannels.get(remotePeerId);
    if (dc && dc.readyState === "open") {
      const message: PeerMessage<T> = {
        type,
        sender: this.localPeerId,
        timestamp: Date.now(),
        payload,
      };
      dc.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  private setupDataChannel(peerId: string, dc: RTCDataChannel) {
    this.dataChannels.set(peerId, dc);

    dc.onopen = () => {
      console.log(`[WebRTC-P2P] Channel open with peer: ${peerId}`);
    };

    dc.onclose = () => {
      console.log(`[WebRTC-P2P] Channel closed with peer: ${peerId}`);
      this.dataChannels.delete(peerId);
    };

    dc.onmessage = (event) => {
      try {
        const parsed: PeerMessage = JSON.parse(event.data);
        this.messageHandlers.forEach((handler) => handler(parsed));
      } catch (e) {
        console.error("[WebRTC-P2P] Failed to parse message:", e);
      }
    };
  }

  public closeAll() {
    this.dataChannels.forEach((dc) => dc.close());
    this.peerConnections.forEach((pc) => pc.close());
    this.dataChannels.clear();
    this.peerConnections.clear();
    this.messageHandlers.clear();
  }
}
