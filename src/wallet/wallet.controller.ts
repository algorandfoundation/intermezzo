import { Body, Controller, Get, Param, Post, Request } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreateAssetDto } from './create-asset.dto';
import { CreateAssetResponseDto } from './create-asset-response.dto';
import { UserInfoResponseDto } from './user-info-response.dto';
import { CreateUserDto } from './create-user.dto';
import { AssetTransferRequestDto } from './asset-transfer-request.dto';
import { AssetTransferResponseDto } from './asset-transfer-response.dto';
import { ManagerDetailDto } from './manager-detail.dto';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiUnauthorizedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { AccountAssetsDto } from './account-assets.dto';
import { AssetClawbackRequestDto } from './asset-clawback-request.dto';

@ApiBearerAuth()
@Controller()
@ApiUnauthorizedResponse({
  description: 'Unauthorized',
})
export class Wallet {
  constructor(private readonly walletService: WalletService) {}

  // Endpoint to get user details
  @Get('wallet/users/:user_id/')
  @ApiOperation({
    summary: 'Get User by ID',
    description: 'Endpoint to get user details by User ID',
  })
  @ApiCreatedResponse({
    description: 'The access token has been successfully created.',
    type: UserInfoResponseDto,
  })
  async userDetail(@Request() request: any, @Param('user_id') user_id: string): Promise<UserInfoResponseDto> {
    // return or 404 if not found
    return await this.walletService.getUserInfo(user_id, request.vault_token);
  }

  // Endpont to get manager details
  @Get('wallet/manager/')
  @ApiOperation({
    summary: 'Get Wallet Manager',
    description:
      'Endpoint to get manager details, including the **Algorand** `public_address` of the **Manager**',
  })
  @ApiOkResponse({
    description: 'The details of the manager',
    type: ManagerDetailDto,
  })
  async managersDetail(@Request() request: any): Promise<ManagerDetailDto> {
    return await this.walletService.getManagerInfo(request.vault_token);
  }

  // Endpoint to fetch asset balance
  @Get('wallet/assets/:user_id')
  @ApiOperation({
    summary: 'Get Account Asset Holdings',
    description:
      'Fetch the account asset holdings for a user by their user ID. The response includes the **Algorand** `public_address` of the user and the list of assets held by the user.',
  })
  @ApiOkResponse({
    description: 'The asset balance has been successfully fetched.',
    type: AccountAssetsDto,
  })
  @ApiNotFoundResponse({
    description: 'Not Found',
  })
  @ApiBadRequestResponse({
    description: 'Bad Request',
  })
  async assetsBalances(
    @Request() request: any,
    @Param('user_id') user_id: string
  ): Promise<AccountAssetsDto> {
    const accountAssets: AssetHolding[] = await this.walletService.getAssetHoldings(user_id, request.vault_token);
    const userPublicAddress: string = (await this.walletService.getUserInfo(user_id, request.vault_token)).public_address;
    const accountAssetsDto: AccountAssetsDto = {
      address: userPublicAddress,
      assets: accountAssets,
    };

    return accountAssetsDto;
  }

  // Endpoint to create a new user
  @Post('wallet/user/')
  @ApiOperation({
    summary: 'Create User',
    description:
      'Create a new **User** in the wallet. The `user_id` is the unique identifier for the user.' +
      'The response includes the **Algorand** `public_address` of the user.',
  })
  @ApiCreatedResponse({
    description: 'A new user has been created.',
    type: UserInfoResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Bad Request',
  })
  async userCreate(@Request() request: any, @Body() newUserParams: CreateUserDto): Promise<UserInfoResponseDto> {
    return this.walletService.userCreate(newUserParams.user_id, request.vault_token);
  }

  // Endpont to get all users keys
  @Get('wallet/users/')
  @ApiOperation({
    summary: 'Get Users',
    description: 'Fetch the list of **Users** in the wallet.',
  })
  async userList(@Request() request: any): Promise<UserInfoResponseDto[]> {
    return this.walletService.getKeys(request.vault_token);
  }

  // Asset creation for manager
  @Post('wallet/transactions/create-asset/')
  @ApiOperation({
    summary: 'Create Asset',
    description: 'Create a new **Algorand** `Asset`.',
  })
  @ApiCreatedResponse({
    description: 'The asset has been successfully created.',
    type: CreateAssetResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Bad Request',
  })
  async createAsset(@Request() request: any, @Body() createAssetDto: CreateAssetDto): Promise<CreateAssetResponseDto> {
    return {
      transaction_id: await this.walletService.createAsset(createAssetDto, request.vault_token),
    };
  }

  // Asset transfer manager to user
  @Post('wallet/transactions/transfer-asset/')
  @ApiOperation({
    summary: 'Transfer Asset',
    description:
      'Send an **Algorand** `Asset` from the **Manager** to a **User**.',
  })
  @ApiCreatedResponse({
    description: 'The asset has been successfully transferred.',
    type: AssetTransferResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Not Found',
  })
  @ApiBadRequestResponse({
    description: 'Bad Request',
  })
  async assetTransferTx(
    @Request() request: any,
    @Body() assetTransferRequestDto: AssetTransferRequestDto,
  ): Promise<AssetTransferResponseDto> {
    return {
      transaction_id: await this.walletService.transferAsset(
        request.vault_token,
        assetTransferRequestDto.assetId,
        assetTransferRequestDto.userId,
        assetTransferRequestDto.amount,
        assetTransferRequestDto.lease,
      ),
    } as AssetTransferResponseDto;
  }

  // Asset clawback by manager
  @Post('wallet/transactions/clawback-asset/')
  @ApiOperation({
    summary: 'Clawback Asset',
    description:
      'Clawback an **Algorand** `Asset` from a **User** to the **Manager**. The `Asset` must have been created with the manager as the clawback address.',
  })
  @ApiCreatedResponse({
    description: 'The asset has been successfully clawed back.',
    type: AssetTransferResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Not Found',
  })
  @ApiBadRequestResponse({
    description: 'Bad Request',
  })
  async assetClawbackTx(
    @Request() request: any,
    @Body() assetClawbackRequestDto: AssetClawbackRequestDto,
  ): Promise<AssetTransferResponseDto> {
    return {
      transaction_id: await this.walletService.clawbackAsset(
        request.vault_token,
        assetClawbackRequestDto.assetId,
        assetClawbackRequestDto.userId,
        assetClawbackRequestDto.amount,
      ),
    } as AssetTransferResponseDto;
  }
}
