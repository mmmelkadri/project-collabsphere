/*

Process is as follows:
1. Retrieve local stream
2. Fetch RTP Capabilities
3. Create a mediasoup Device
4. Create a producer transport
5. Connect producer transport
6. Create receiver transport
7. Connect receiver transport

*/

const PRINT_DEBUG = false
const log = (...args: any) => {
  if (PRINT_DEBUG) {
    console.log(...args)
  }
}

const media_configs = {
  encodings: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'audio',
      mimeType: 'audio/PCMU',
      clockRate: 8000,
      channels: 1,
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90000,
    },
    {
      kind: 'video',
      mimeType: 'video/H264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1,
      },
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
}

import * as mediasoup from 'mediasoup-client'
import type { TransportOptions } from 'mediasoup-client/lib/types'
import { ref, toRaw, type Ref } from 'vue'
import { Socket } from 'socket.io-client'

let myProducerId = null
let username = 'unknown'

interface ClientStreamData {
  id?: string
  username: string
  audio: boolean
  video: boolean
  stream: MediaStream
  isLocal?: boolean
}

let producers: { [key: string]: any } = {}

let socket = null
const device: Ref<mediasoup.types.Device | null> = ref(null)
// Defined either in bindConsumer (existing streams)
// or when a new producer is introduced
const consumerTransport: Ref<mediasoup.types.Transport | null> = ref(null)
const producerTransport: Ref<mediasoup.types.Transport | null> = ref(null)
const clientConfigData: Ref<Map<string, ClientStreamData>> = ref(new Map())

/* wrappers to ensure only one transport is created, and is kept track of */
const createRecvTransport = async (device: mediasoup.types.Device) => {
  if (consumerTransport.value != null) return toRaw(consumerTransport.value)

  const params = await new Promise(resolve =>
    socket?.emit('create_transport', params => {
      resolve(params)
    }),
  )

  const newRecvTransport = device.createRecvTransport(params)

  newRecvTransport.on('connect', async ({ dtlsParameters }, callback) => {
    socket?.emit(
      'connect_transport',
      { transportId: newRecvTransport.id, dtlsParameters },
      () => {
        log('7. Consumer Connected transport')
        callback()
      },
    )
  })

  consumerTransport.value = newRecvTransport
  log(`++ 6. Creating consumer (id=${newRecvTransport.id}) transport`)
  return newRecvTransport
}

const createSendTransport = async (device: mediasoup.types.Device) => {
  if (producerTransport.value != null) return toRaw(producerTransport.value)

  const params = await new Promise(resolve =>
    socket?.emit('create_transport', params => {
      resolve(params)
    }),
  )
  // Initialize a producer webRTC transport
  const newSendTransport = device.createSendTransport(params)

  newSendTransport.on('connect', async ({ dtlsParameters }, callback) => {
    socket?.emit(
      'connect_transport',
      { transportId: newSendTransport.id, dtlsParameters },
      () => {
        log('5. Producer Connected transport')
        callback()
      },
    )
  })

  newSendTransport.on('produce', async (content, callback) => {
    const { kind, rtpParameters, appData } = content

    // Call the server to setup the producer.
    socket?.emit(
      'produce',
      {
        transportId: newSendTransport.id,
        kind,
        rtpParameters,
        appData,
      },
      response => {
        if (response.error) {
          console.error('Error producing', response.error)
          callback({ error: response.error })
          return
        }
        const { id } = response

        callback({ id })
      },
    )
  })

  producerTransport.value = newSendTransport
  log(`++ 4. Creating producer (id=${newSendTransport.id}) transport`)
  return newSendTransport
}

const getDevice = async (
  routerRtpCapabilities = null,
): Promise<mediasoup.types.Device | null> => {
  try {
    if (device.value != null) {
      return device.value
    }

    if (routerRtpCapabilities == null) {
      console.error('Router RTP Capabilities are null')
      return null
    }

    const newDevice = new mediasoup.Device()
    await newDevice.load({ routerRtpCapabilities })

    device.value = newDevice
    return newDevice
  } catch (e) {
    log(e)
    if (e.name == 'UnsupportedError') {
      console.warn('Unsupported Browser.')
    }
  }

  console.error('Device is null')
  return null
}

function bindConsumer(producerData) {
  const { producerId, params, appData } = producerData
  let client_username = 'unknown'
  if (appData) {
    client_username = appData.username || 'unknown'
  }

  // Check if producer already exists
  if (producers[producerId]) return
  producers[producerId] = 1

  return new Promise(async (resolve, reject) => {
    const device = await getDevice()
    const consumerTransport = await createRecvTransport(device)

    socket?.emit(
      'consume',
      {
        transportId: consumerTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      },
      async ({ params, error }) => {
        if (error) {
          log('Error consuming', error)
          return reject(Error(`Cannot consume`))
        }

        const kind = params.kind
        const consumer = await consumerTransport?.consume({
          id: params.id,
          producerId: params.producerId,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
        })

        if (consumer.paused) {
          await consumer.resume()
        }

        // Check tracks exist
        if (!consumer.track) {
          console.error('No tracks found')
          return
        }

        log('8. Retrieving consumer')

        addClientStream({
          id: appData.id,
          username: client_username,
          audio: kind === 'audio',
          video: kind === 'video',
          stream: new MediaStream([consumer.track]),
        })

        socket?.emit('consumer-resume', { consumerId: params.id })
        resolve(1)
      },
    )
  })
}

async function bindExistingConsumers(producerIds) {
  log("ProducerID's to consume:", producerIds)
  // Bind consumers for all existing producers
  for (const producerId of producerIds) {
    if (producerId == myProducerId) {
      continue
    }

    try {
      await bindConsumer(producerId)
    } catch (e) {
      console.error('Error binding consumer', e)
    }
  }
}

async function initializeStreams(data, hasMedia = true) {
  const { routerRtpCapabilities, producerIds } = data

  const device = await getDevice(routerRtpCapabilities)
  if (device == null) {
    return
  }

  if (hasMedia) {
    const producerTransport = await createSendTransport(device)

    // Check that producer transport is valid
    if (!producerTransport) {
      console.error('Producer transport is invalid')
      return
    }

    const stream = await retrieveLocalStream()
    const videoTrack = stream?.getVideoTracks()[0]

    const payload = {
      ...media_configs,
      track: videoTrack,
      appData: { username },
    }

    const prod_trans = await producerTransport.produce(payload)

    myProducerId = prod_trans.id
    if (prod_trans.paused) {
      await prod_trans.resume()
    }

    log('Track ID:', prod_trans.id)
  }

  // Create producer transport
  socket?.on('new_producer', async producerData => {
    log('New producer', producerData)
    await bindConsumer(producerData)
  })

  bindExistingConsumers(producerIds)
}

async function retrieveLocalStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      // video: true,
      audio: false,
      video: {
        width: {
          min: 640,
          max: 1920,
        },
        height: {
          min: 400,
          max: 1080,
        },
      },
    })

    return stream
  } catch (e) {
    console.error('Error retrieving local stream', e)
    return null
  }
}

/* Returns true if has media */
async function checkHasMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    })
    const devices = await navigator.mediaDevices.enumerateDevices()
    let audioSource: string | null = null
    let videoSource: string | null = null
    devices.forEach(device => {
      if (device.kind === 'audioinput') {
        audioSource = device.deviceId
      } else if (device.kind === 'videoinput') {
        videoSource = device.deviceId
      }
    })
    return true
  } catch (err) {
    if (err.name === 'NotFoundError') {
      log('No media devices found.')
    } else {
      console.error(`${err.name}: ${err.message}`)
    }
    return false
    // alert("navigator.mediaDevices.getUserMedia() is not supported or an error occurred.");
  }
}

async function setupMedia(_socket: Socket, _username: string) {
  socket = _socket
  username = _username

  // Retrieve a local stream
  let hasMedia = await checkHasMedia()
  const local_stream = await retrieveLocalStream()
  if (!local_stream) {
    return console.error('No stream found')
  }

  // Fetch RTP Capabilities
  const { rtpCapabilities } = await new Promise(resolve => {
    socket?.emit('get_rtp_capabilities', resolve)
  })

  if (!rtpCapabilities) {
    return console.error('No router RTP capabilities found')
  }

  log('RTP Capabilities', rtpCapabilities)
  // Create a mediasoup Device
  const device = await getDevice(rtpCapabilities)
  if (!device) {
    return console.error('No device found')
  }

  // Create a producer transport (automatically connects)
  await createSendTransport(device)
  await createRecvTransport(device)

  // Initialize streams
  socket?.emit('join_stream_room', async params => {
    await initializeStreams(params, hasMedia)

    addClientStream({
      id: params.id,
      username: 'You',
      audio: true,
      video: true,
      stream: local_stream,
      isLocal: true,
    })
  })

  socket?.on('remove_client', id => {
    removeClientStream(id)
  })
}

function addClientStream(data: ClientStreamData) {
  if (data.id == null) {
    console.error('Client stream ID is null')
    return
  }

  if (clientConfigData.value.has(data.id)) {
    console.error('Client stream already exists')
    return
  }

  clientConfigData.value.set(data.id, data)
}

function removeClientStream(id: string) {
  if (!clientConfigData.value.has(id)) {
    console.error('Client stream not found')
    return
  }

  clientConfigData.value.delete(id)
}

export { setupMedia, removeClientStream, addClientStream, clientConfigData }
