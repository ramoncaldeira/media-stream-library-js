const {Transform} = require('stream')

const Component = require('../component')
const {ISOM, SDP, ELEMENTARY} = require('../messageTypes')

const BoxBuilder = require('./helpers/boxbuilder')

const {Box} = require('./helpers/isom')

const debug = require('debug')

/**
 * Component that converts elementary stream data into MP4 boxes honouring
 * the ISO BMFF Byte Stream (Some extra restrictions are involved).
 */
class Mp4MuxerComponent extends Component {
  /**
   * Create a new mp4muxer component.
   * @return {undefined}
   */
  constructor () {
    const boxBuilder = new BoxBuilder()
    const incoming = new Transform({
      objectMode: true,
      transform (msg, encoding, callback) {
        if (msg.type === SDP) {
          /**
           * Arrival of SDP signals the beginning of a new movie.
           * Set up the ftyp and moov boxes.
           */

          delete this._ntpPresentationTime

          // Why is this here? These should be default inside the mvhd box?
          const now = Math.floor(((new Date()).getTime() / 1000) + 2082852000)
          const ftyp = new Box('ftyp')
          const moov = boxBuilder.moov(msg.sdp, now)

          const data = Buffer.allocUnsafe(ftyp.byteLength + moov.byteLength)
          ftyp.copy(data, 0)
          moov.copy(data, ftyp.byteLength)

          debug('live:mp4:ftyp')(ftyp)
          debug('live:mp4:moov')(moov)

          this.push(msg) // Pass on the original SDP message
          this.push({type: ISOM, data, ftyp, moov})
        } else if (msg.type === ELEMENTARY) {
          /**
           * Otherwise we are getting some elementary stream data.
           * Set up the moof and mdat boxes.
           */

          const {payloadType, timestamp, ntpTimestamp} = msg
          const trackId = boxBuilder.trackIdMap[payloadType]

          if (trackId) {
            // Before updating the baseMediaDecodeTime, we check if
            // there is already a base NTP time to use as a reference
            // for computing presentation times.
            if (!this._ntpPresentationTime && ntpTimestamp && trackId === boxBuilder.videoTrackId) {
              const trackOffset = trackId - 1
              const trackData = boxBuilder.trackData[trackOffset]
              this._ntpPresentationTime = ntpTimestamp - 1000 * (trackData.baseMediaDecodeTime / trackData.clockrate)
            }

            const byteLength = msg.data.byteLength
            const moof = boxBuilder.moof({trackId, timestamp, byteLength})
            const mdat = boxBuilder.mdat(msg.data)

            const data = Buffer.allocUnsafe(moof.byteLength + mdat.byteLength)
            moof.copy(data, 0)
            mdat.copy(data, moof.byteLength)

            this.push({type: ISOM, data, moof, mdat, ntpTimestamp})
          }
        } else {
          // No message type we recognize, pass it on.
          this.push(msg)
        }
        callback()
      }
    })

    super(incoming)
    this.boxBuilder = boxBuilder
  }

  get bitrate () {
    return this.boxBuilder.trackData.map((data) => data.bitrate)
  }

  get framerate () {
    return this.boxBuilder.trackData.map((data) => data.framerate)
  }

  get ntpPresentationTime () {
    return this._ntpPresentationTime
  }
};

module.exports = Mp4MuxerComponent