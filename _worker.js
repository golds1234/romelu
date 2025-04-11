// @ts-ignore
import { connect } from 'cloudflare:sockets';

// Configuration constants
const DEFAULT_USER_ID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const PROXY_HOSTS = ['www.samsung.com', 'www.adobe.com'];
const DEFAULT_PROXY_IP = "[2a01:4f8:c2c:123f:64:5:6810:c55a]"; // IPv6 example
const DEFAULT_DOH_URL = 'https://freedns.controld.com/p0';

// Base64 encoded constants
const AT = 'QA=='; // @ symbol
const PT = 'dmxlc3M='; // vless
const ED = 'RUR0dW5uZWw='; // EDtunnel

// Port sets
const HTTP_PORTS = new Set([80, 8080, 8880, 2052, 2086, 2095, 2082]);
const HTTPS_PORTS = new Set([443, 8443, 2053, 2096, 2087, 2083]);

// Chinese hostnames for random proxy
const CN_HOSTNAMES = [
    'cdn.appsflyer.com',
    // Add more hostnames as needed
];

// WebSocket ready states
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

let userID = DEFAULT_USER_ID;
let proxyIP = DEFAULT_PROXY_IP;
let dohURL = DEFAULT_DOH_URL;

/**
 * Validates if a string is a proper UUID
 * @param {string} uuid 
 * @returns {boolean}
 */
function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

/**
 * Safely closes a WebSocket connection
 * @param {import("@cloudflare/workers-types").WebSocket} socket 
 */
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('Error closing WebSocket:', error);
    }
}

/**
 * Processes the VLESS protocol header
 * @param {ArrayBuffer} vlessBuffer 
 * @param {string} userID 
 * @returns {Object}
 */
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true, message: 'Invalid data' };
    }

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
    const slicedBufferString = stringifyUUID(slicedBuffer);

    const uuids = userID.includes(',') ? userID.split(",") : [userID];
    const isValidUser = uuids.some(uuid => slicedBufferString === uuid.trim());

    if (!isValidUser) {
        return { hasError: true, message: 'Invalid user' };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    let isUDP = false;
    if (command === 1) {
        isUDP = false;
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `Command ${command} not supported (01-tcp,02-udp,03-mux)`
        };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];

    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            ).join('.');
            break;
        case 2: // Domain
            addressLength = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
            )[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            break;
        case 3: // IPv6
            addressLength = 16;
            const dataView = new DataView(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return {
                hasError: true,
                message: `Invalid address type: ${addressType}`
            };
    }

    if (!addressValue) {
        return {
            hasError: true,
            message: `Empty address value for type ${addressType}`
        };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP,
    };
}

/**
 * Creates a readable stream from WebSocket messages
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer 
 * @param {string} earlyDataHeader 
 * @param {function} log 
 * @returns {ReadableStream}
 */
function createWebSocketReadableStream(webSocketServer, earlyDataHeader, log) {
    let isStreamCancelled = false;
    
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                controller.enqueue(event.data);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                log('WebSocket server error');
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            log(`Stream cancelled: ${reason}`);
            isStreamCancelled = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
}

/**
 * Converts base64 to ArrayBuffer
 * @param {string} base64Str 
 * @returns {Object}
 */
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arrayBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

/**
 * Handles TCP outbound connections
 * @param {Object} remoteSocket 
 * @param {string} remoteAddress 
 * @param {number} remotePort 
 * @param {Uint8Array} clientData 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {Uint8Array} vlessResponseHeader 
 * @param {function} log 
 */
async function handleTCPOutbound(remoteSocket, remoteAddress, remotePort, clientData, webSocket, vlessResponseHeader, log) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        log(`Connected to ${address}:${port}`);
        
        const writer = tcpSocket.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || remoteAddress, remotePort);
        tcpSocket.closed.catch(error => {
            console.log('TCP socket closed with error:', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });
        forwardRemoteToWebSocket(tcpSocket, webSocket, vlessResponseHeader, null, log);
    }

    const tcpSocket = await connectAndWrite(remoteAddress, remotePort);
    forwardRemoteToWebSocket(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * Forwards data from remote socket to WebSocket
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer|null} vlessResponseHeader 
 * @param {function|null} retry 
 * @param {function} log 
 */
async function forwardRemoteToWebSocket(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
    let remoteChunkCount = 0;
    let hasIncomingData = false;
    
    await remoteSocket.readable.pipeTo(
        new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                remoteChunkCount++;
                
                if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                    throw new Error('WebSocket not open');
                }
                
                if (vlessResponseHeader) {
                    webSocket.send(await new Blob([vlessResponseHeader, chunk]).arrayBuffer());
                    vlessResponseHeader = null;
                } else {
                    webSocket.send(chunk);
                }
            },
            close() {
                log(`Remote socket closed. Incoming data: ${hasIncomingData}`);
            },
            abort(reason) {
                console.error('Remote socket aborted:', reason);
            },
        })
    ).catch(error => {
        console.error('Remote to WebSocket error:', error.stack || error);
        safeCloseWebSocket(webSocket);
    });

    if (!hasIncomingData && retry) {
        log('Retrying connection...');
        retry();
    }
}

/**
 * Handles UDP outbound traffic (DNS)
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {function} log 
 * @returns {Object}
 */
async function handleUDPOutbound(webSocket, vlessResponseHeader, log) {
    let isHeaderSent = false;
    
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(
                    chunk.slice(index + 2, index + 2 + udpLength)
                );
                index = index + 2 + udpLength;
                controller.enqueue(udpData);
            }
        }
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch(dohURL, {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk,
            });
            
            const dnsResult = await response.arrayBuffer();
            const udpSize = dnsResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
            
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                log(`DNS success. Message length: ${udpSize}`);
                
                if (isHeaderSent) {
                    webSocket.send(await new Blob([udpSizeBuffer, dnsResult]).arrayBuffer());
                } else {
                    webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsResult]).arrayBuffer());
                    isHeaderSent = true;
                }
            }
        }
    })).catch(error => {
        log('DNS UDP error: ' + error);
    });

    const writer = transformStream.writable.getWriter();

    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}

/**
 * Generates VLESS configuration for users
 * @param {string} userIDs 
 * @param {string|null} hostName 
 * @returns {string}
 */
function generateVlessConfig(userIDs, hostName) {
    if (!hostName) return '';
    
    const commonUrlPart = `:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
    const separator = "################################################################";
    
    const userIDArray = userIDs.split(",");
    
    const configs = userIDArray.map(userID => {
        const mainConfig = `${atob(PT)}://${userID}${atob(AT)}${hostName}${commonUrlPart}`;
        const altConfig = `${atob(PT)}://${userID}${atob(AT)}${proxyIP}${commonUrlPart}`;
        
        return `<h2>UUID: ${userID}</h2>${separator}
v2ray default IP
---------------------------------------------------------------
${mainConfig}
<button onclick='copyToClipboard("${mainConfig}")'><i class="fa fa-clipboard"></i> Copy Main Config</button>
---------------------------------------------------------------
v2ray with best IP
---------------------------------------------------------------
${altConfig}
<button onclick='copyToClipboard("${altConfig}")'><i class="fa fa-clipboard"></i> Copy Alt Config</button>
---------------------------------------------------------------`;
    }).join('\n');
    
    const subLink = `https://${hostName}/sub/${userIDArray[0]}`;
    const bestIpLink = `https://${hostName}/bestip/${userIDArray[0]}`;
    const clashLink = `https://api.v1.mk/sub?target=clash&url=${encodeURIComponent(subLink)}&insert=false&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
    
    const header = `
<p align='center'>
<img src='https://cloudflare-ipfs.com/ipfs/bafybeigd6i5aavwpr6wvnwuyayklq3omonggta4x2q7kpmgafj357nkcky' alt='Logo' style='margin-bottom: -50px;'>
<b style='font-size: 15px;'>Welcome! This generates VLESS protocol configurations. If useful, please star our GitHub project:</b>
<b style='font-size: 15px;'>欢迎！生成 VLESS 协议配置。如果好用，请给我们的 GitHub 项目点星：</b>
<a href='https://github.com/3Kmfi6HP/EDtunnel' target='_blank'>EDtunnel - https://github.com/3Kmfi6HP/EDtunnel</a>
<iframe src='https://ghbtns.com/github-btn.html?user=USERNAME&repo=REPOSITORY&type=star&count=true&size=large' frameborder='0' scrolling='0' width='170' height='30' title='GitHub'></iframe>
<a href='//${hostName}/sub/${userIDArray[0]}' target='_blank'>VLESS Subscription</a>
<a href='clash://install-config?url=${encodeURIComponent(`https://${hostName}/sub/${userIDArray[0]}?format=clash`)}}' target='_blank'>Clash for Windows</a>
<a href='${clashLink}' target='_blank'>Clash Subscription</a>
<a href='${bestIpLink}' target='_blank'>Best IP Auto Subscription</a>
<a href='clash://install-config?url=${encodeURIComponent(bestIpLink)}' target='_blank'>Clash Best IP</a>
<a href='sing-box://import-remote-profile?url=${encodeURIComponent(bestIpLink)}' target='_blank'>SingBox Best IP</a>
<a href='sn://subscription?url=${encodeURIComponent(bestIpLink)}' target='_blank'>NekoBox Best IP</a>
<a href='v2rayng://install-config?url=${encodeURIComponent(bestIpLink)}' target='_blank'>v2rayNG Best IP</a></p>`;

    const htmlHead = `
<head>
    <title>EDtunnel: VLESS Configuration</title>
    <meta name='description' content='VLESS protocol configuration generator'>
    <meta name='keywords' content='EDtunnel, cloudflare, worker'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <meta property='og:site_name' content='EDtunnel: VLESS Configuration' />
    <meta property='og:type' content='website' />
    <meta property='og:title' content='EDtunnel - VLESS Configuration' />
    <meta property='og:description' content='VLESS protocol configuration generator' />
    <meta property='og:url' content='https://${hostName}/' />
    <meta property='og:image' content='https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(`vless://${userIDs.split(",")[0]}@${hostName}${commonUrlPart}`)}' />
    <meta name='twitter:card' content='summary_large_image' />
    <meta name='twitter:title' content='EDtunnel - VLESS Configuration' />
    <meta name='twitter:description' content='VLESS protocol configuration generator' />
    <meta name='twitter:url' content='https://${hostName}/' />
    <meta name='twitter:image' content='https://cloudflare-ipfs.com/ipfs/bafybeigd6i5aavwpr6wvnwuyayklq3omonggta4x2q7kpmgafj357nkcky' />
    <meta property='og:image:width' content='1500' />
    <meta property='og:image:height' content='1500' />

    <style>
    body {
        font-family: Arial, sans-serif;
        background-color: #f0f0f0;
        color: #333;
        padding: 10px;
    }
    a {
        color: #1a0dab;
        text-decoration: none;
    }
    img {
        max-width: 100%;
        height: auto;
    }
    pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        background-color: #fff;
        border: 1px solid #ddd;
        padding: 15px;
        margin: 10px 0;
    }
    @media (prefers-color-scheme: dark) {
        body {
            background-color: #333;
            color: #f0f0f0;
        }
        a {
            color: #9db4ff;
        }
        pre {
            background-color: #282a36;
            border-color: #6272a4;
        }
    }
    </style>
    <link rel='stylesheet' href='https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css'>
</head>`;

    return `
<html>
${htmlHead}
<body>
<pre style='background-color: transparent; border: none;'>${header}</pre>
<pre>${configs}</pre>
</body>
<script>
function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
        .then(() => alert("Copied to clipboard"))
        .catch(err => console.error("Copy failed:", err));
}
</script>
</html>`;
}

/**
 * Generates VLESS subscription configuration
 * @param {string} userIDPath 
 * @param {string} hostName 
 * @returns {string}
 */
function generateVlessSubscription(userIDPath, hostName) {
    const userIDs = userIDPath.includes(',') ? userIDPath.split(',') : [userIDPath];
    const commonHttpUrl = `?encryption=none&security=none&fp=random&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#`;
    const commonHttpsUrl = `?encryption=none&security=tls&sni=${hostName}&fp=random&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#`;

    const configs = userIDs.flatMap(userID => {
        const httpConfigs = Array.from(HTTP_PORTS).flatMap(port => {
            if (!hostName.includes('pages.dev')) {
                const urlPart = `${hostName}-HTTP-${port}`;
                const mainConfig = `${atob(PT)}://${userID}${atob(AT)}${hostName}:${port}${commonHttpUrl}${urlPart}`;
                
                return PROXY_HOSTS.flatMap(proxyHost => {
                    const altConfig = `${atob(PT)}://${userID}${atob(AT)}${proxyHost}:${port}${commonHttpUrl}${urlPart}-${proxyHost}-${atob(ED)}`;
                    return [mainConfig, altConfig];
                });
            }
            return [];
        });

        const httpsConfigs = Array.from(HTTPS_PORTS).flatMap(port => {
            const urlPart = `${hostName}-HTTPS-${port}`;
            const mainConfig = `${atob(PT)}://${userID}${atob(AT)}${hostName}:${port}${commonHttpsUrl}${urlPart}`;
            
            return PROXY_HOSTS.flatMap(proxyHost => {
                const altConfig = `${atob(PT)}://${userID}${atob(AT)}${proxyHost}:${port}${commonHttpsUrl}${urlPart}-${proxyHost}-${atob(ED)}`;
                return [mainConfig, altConfig];
            });
        });

        return [...httpConfigs, ...httpsConfigs];
    });

    return configs.join('\n');
}

/**
 * Handles WebSocket connections for VLESS protocol
 * @param {import("@cloudflare/workers-types").Request} request 
 * @returns {Promise<Response>}
 */
async function handleVlessWebSocket(request) {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    let address = '';
    let portWithLog = '';
    const currentDate = new Date();
    
    const log = (info, event) => {
        console.log(`[${currentDate} ${address}:${portWithLog}] ${info}`, event || '');
    };

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketReadableStream(server, earlyDataHeader, log);

    const remoteSocketWrapper = { value: null };
    let udpStreamWriter = null;
    let isDns = false;

    readableStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWriter) {
                return udpStreamWriter(chunk);
            }
            if (remoteSocketWrapper.value) {
                const writer = remoteSocketWrapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                vlessVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processVlessHeader(chunk, userID);
            
            address = addressRemote;
            portWithLog = `${portRemote} ${isUDP ? 'udp' : 'tcp'}`;
            
            if (hasError) {
                throw new Error(message);
            }

            if (isUDP && portRemote !== 53) {
                throw new Error('UDP proxy only enabled for DNS (port 53)');
            }

            if (isUDP && portRemote === 53) {
                isDns = true;
            }

            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);

            if (isDns) {
                const { write } = await handleUDPOutbound(server, vlessResponseHeader, log);
                udpStreamWriter = write;
                udpStreamWriter(rawClientData);
                return;
            }
            
            handleTCPOutbound(
                remoteSocketWrapper,
                addressRemote,
                portRemote,
                rawClientData,
                server,
                vlessResponseHeader,
                log
            );
        },
        close() {
            log('WebSocket stream closed');
        },
        abort(reason) {
            log('WebSocket stream aborted', JSON.stringify(reason));
        },
    })).catch(err => {
        log('WebSocket stream error', err);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

// UUID stringification helpers
const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringifyUUID(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + 
            byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + 
            "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + 
            byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + 
            byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + 
            byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringifyUUID(arr, offset = 0) {
    const uuid = unsafeStringifyUUID(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Invalid UUID");
    }
    return uuid;
}

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXY_IP || proxyIP;
            dohURL = env.DNS_RESOLVER_URL || dohURL;
            
            let userIDPath = userID;
            if (userID.includes(',')) {
                userIDPath = userID.split(',')[0];
            }

            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                
                switch (url.pathname) {
                    case `/cf`: {
                        return new Response(JSON.stringify(request.cf, null, 4), {
                            status: 200,
                            headers: { "Content-Type": "application/json;charset=utf-8" },
                        });
                    }
                    case `/${userIDPath}`: {
                        const vlessConfig = generateVlessConfig(userID, request.headers.get('Host'));
                        return new Response(vlessConfig, {
                            status: 200,
                            headers: { "Content-Type": "text/html; charset=utf-8" }
                        });
                    }
                    case `/sub/${userIDPath}`: {
                        const vlessSubConfig = generateVlessSubscription(userID, request.headers.get('Host'));
                        return new Response(btoa(vlessSubConfig), {
                            status: 200,
                            headers: { "Content-Type": "text/plain;charset=utf-8" }
                        });
                    }
                    case `/bestip/${userIDPath}`: {
                        const headers = request.headers;
                        const url = `https://sub.xf.free.hr/auto?host=${request.headers.get('Host')}&uuid=${userID}&path=/`;
                        const bestSubConfig = await fetch(url, { headers: headers });
                        return bestSubConfig;
                    }
                    default: {
                        const randomHostname = CN_HOSTNAMES[Math.floor(Math.random() * CN_HOSTNAMES.length)];
                        const newHeaders = new Headers(request.headers);
                        
                        newHeaders.set('cf-connecting-ip', '1.2.3.4');
                        newHeaders.set('x-forwarded-for', '1.2.3.4');
                        newHeaders.set('x-real-ip', '1.2.3.4');
                        newHeaders.set('referer', 'https://www.google.com/search?q=edtunnel');
                        
                        const proxyUrl = 'https://' + randomHostname + url.pathname + url.search;
                        const modifiedRequest = new Request(proxyUrl, {
                            method: request.method,
                            headers: newHeaders,
                            body: request.body,
                            redirect: 'manual',
                        });
                        
                        const proxyResponse = await fetch(modifiedRequest, { redirect: 'manual' });
                        
                        if ([301, 302].includes(proxyResponse.status)) {
                            return new Response(`Redirects to ${randomHostname} are not allowed.`, {
                                status: 403,
                                statusText: 'Forbidden',
                            });
                        }
                        
                        return proxyResponse;
                    }
                }
            } else {
                return await handleVlessWebSocket(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
