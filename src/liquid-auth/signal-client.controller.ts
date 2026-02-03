import { Controller, Get, Param, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { Public } from '../auth/constants';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SignalClientManager } from './signal-client.manager';

@ApiTags('Liquid')
@Controller('liquid')
export class SignalClientController {
  private readonly logger = new Logger(SignalClientController.name);

  constructor(private readonly manager: SignalClientManager) { }

  /**
   * Kick off a signaling session as offer and return the requestId.
   * Optionally accept a client-provided requestId and basic RTC config params.
   */
  @Public()
  @Get('start')
  @ApiOperation({ summary: 'Start Liquid Auth signaling as offer' })
  @ApiOkResponse({ description: 'Returns a new requestId and session metadata' })
  async start() {
    const rtcConfig: RTCConfiguration = {
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302',
            'stun:stun2.l.google.com:19302',
            'stun:stun3.l.google.com:19302',
            'stun:stun4.l.google.com:19302',
          ],
        },
        {
          urls: [
            'turn:global.turn.nodely.network:80?transport=tcp',
            'turns:global.turn.nodely.network:443?transport=tcp',
            'turn:eu.turn.nodely.io:80?transport=tcp',
            'turns:eu.turn.nodely.io:443?transport=tcp',
            'turn:us.turn.nodely.io:80?transport=tcp',
            'turns:us.turn.nodely.io:443?transport=tcp',
          ],
          username: 'liquid-auth',
          credential: 'sqmcP4MiTKMT4TGEDSk9jgHY',
        },
      ],
    };

    const url = 'https://debug.liquidauth.com';
    this.logger.log('Starting Liquid Auth session');
    try {
      const session = await this.manager.startOffer(url, undefined, rtcConfig);
      return {
        requestId: session.requestId,
        expiresAt: session.expiresAt,
        status: session.state,
        origin: url,
      };
    } catch (err: any) {
      // Bubble an HTTP error so clients don't treat this as a valid session
      throw new ServiceUnavailableException(`Liquid Auth start failed: ${err?.message || err}`);
    }
  }

  /**
   * Get the status of a signaling session by requestId.
   */
  @Public()
  @Get('status/:requestId')
  @ApiOperation({ summary: 'Get status of a Liquid Auth signaling session' })
  @ApiOkResponse({ description: 'Returns session status and metadata' })
  async status(@Param('requestId') requestId: string) {
    const session = this.manager.get(requestId);
    if (!session) {
      throw new NotFoundException(`Session with requestId ${requestId} not found or expired.`);
    }
    return {
      requestId: session.requestId,
      expiresAt: session.expiresAt,
      status: session.state,
      origin: session.url,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
    };
  }
}
