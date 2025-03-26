import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreateAssetDto } from './create-asset.dto';
import { CreateAssetResponseDto } from './create-asset-response.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import { CreateUserDto } from './create-user.dto';
import { AssetTransferRequestDto } from './asset-transfer-request.dto';
import { AssetTransferResponseDto } from './asset-transfer-response.dto';
import { ManagerDetailDto } from './manager-detail.dto';

@Controller()
export class Wallet {
  constructor(private readonly walletService: WalletService) {}

  // Endpoint to get user details
  @Get('wallet/users/:user_id/')
  async userDetail(@Request() request: any, @Param('user_id') user_id: string): Promise<UserInfoResponseDto> {
    // return or 404 if not found
    return await this.walletService.getUserInfo(user_id, request.vault_token);
  }

  // Endpont to get manager details
  @Get('wallet/manager/')
  async managersDetail(@Request() request: any): Promise<ManagerDetailDto> {
    return await this.walletService.getMangerInfo(request.vault_token);
  }

  // Endpoint to create a new user
  @Post('wallet/user/')
  async userCreate(@Request() request: any, @Body() newUserParams: CreateUserDto): Promise<UserInfoResponseDto> {
    return this.walletService.userCreate(newUserParams.user_id, request.vault_token);
  }

  // Endpont to get all users keys
  @Get('wallet/users/')
  async userList(@Request() request: any): Promise<UserInfoResponseDto[]> {
    return this.walletService.getKeys(request.vault_token);
  }

  // Asset creation for manager
  @Post('wallet/transactions/create-asset/')
  async createAsset(@Request() request: any, @Body() createAssetDto: CreateAssetDto): Promise<CreateAssetResponseDto> {
    return {
      transaction_id: await this.walletService.createAsset(createAssetDto, request.vault_token),
    };
  }

  // Asset transfer manager to user
  @Post('wallet/transactions/transfer-asset/')
  async assetTransferTx(
    @Request() request: any,
    @Body() assetTransferRequestDto: AssetTransferRequestDto,
  ): Promise<AssetTransferResponseDto> {
    return {
      transaction_id: await this.walletService.transferAsset(
        assetTransferRequestDto.assetId,
        assetTransferRequestDto.userId,
        assetTransferRequestDto.amount,
        request.vault_token,
      ),
    } as AssetTransferResponseDto;
  }
}
