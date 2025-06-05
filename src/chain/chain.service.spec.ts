import { ChainService } from './chain.service';
import { ConfigService } from '@nestjs/config';
import { AlgorandEncoder } from '@algorandfoundation/algo-models';
import createMockInstance from 'jest-create-mock-instance';
import { HttpService } from '@nestjs/axios';
import { Axios } from 'axios';

describe('ChainService', () => {
  let chainService: ChainService;

  let httpServiceMock: jest.Mocked<HttpService>;
  let configServiceMock: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    configServiceMock = createMockInstance(ConfigService);
    configServiceMock.get.mockImplementation((key: string) => {
      const config = {
        GENESIS_ID: 'test-genesis-id',
        GENESIS_HASH: 'test-genesis-hash',
        NODE_HTTP_SCHEME: 'http',
        NODE_HOST: 'localhost',
        NODE_PORT: '4001',
        NODE_TOKEN: 'test-token',
      };
      return config[key];
    });

    httpServiceMock = createMockInstance(HttpService);
    Object.defineProperty(httpServiceMock, 'axiosRef', {
      value: createMockInstance(Axios),
    });

    chainService = new ChainService(configServiceMock, httpServiceMock);
  });

  describe('addSignatureToTxn', () => {
    it('should add a signature to a given transaction', () => {
      const txn = Uint8Array.of(1, 2, 3);
      const sig = Uint8Array.of(4, 5, 6);

      const result = chainService.addSignatureToTxn(txn, sig);

      // Since we are not mocking crafter, we cannot directly assert calls to its methods.
      // We can only assert the output of the method.
      expect(result).toBeInstanceOf(Uint8Array);
      // It's harder to validate the exact output without mocking, but you can add basic checks
      expect(result.length).toBeGreaterThan(txn.length); // Signature should increase the length
    });
  });

  describe('setGroupID', () => {
    it('should set the group ID for a list of transactions', async () => {
      // mock suggested params to avoid calling the real API
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });

      const txns: Uint8Array[] = [
        await chainService.craftPaymentTx(
          'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
          'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
          0,
        ),
        await chainService.craftPaymentTx(
          'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
          'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
          2,
        ),
      ];

      const groupedTxns: Uint8Array[] = chainService.setGroupID(txns);

      expect(groupedTxns.length).toBe(txns.length);
      const groupId = new AlgorandEncoder().computeGroupId(txns);
      for (const txn of groupedTxns) {
        const decodedTx = new AlgorandEncoder().decodeTransaction(txn);
        expect(decodedTx.grp).toEqual(groupId);
      }
    });
  });

  describe('craftAssetCreateTx', () => {
    it('should craft an asset creation transaction', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });

      // Use a valid dummy Algorand address for all address options.
      const dummyAddress1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
      const dummyAddress2 = 'MONEYMBRSMUAM2NGL6PCEQEDVHFWAQB6DU47NUS6P5DJM4OJFN7E7DSVBA';
      const dummyAddress3 = 'DMYOIEE6HAIQF5QUF4XGNBL4GUZOZF6RFQCCB2NXP35AKK2674HBILQQLA';
      const dummyAddress4 = '6L7ABTLU2BZOZPTNO7FT3F35622CLGBCMMQGLOFUNDTSEZHIL62IARTTR4';
      const dummyAddress5 = 'IXQNL3EO457FGY2IWRCNP6ZZW45KCTFBEAYZN337ZJ4NB4VZ5OG62WX2ZE';

      const creatorAddress = dummyAddress1;
      const options = {
        total: 1000,
        decimals: BigInt(2),
        defaultFrozen: false,
        unitName: 'UNIT',
        assetName: 'Asset',
        url: 'http://example.com',
        managerAddress: dummyAddress2,
        reserveAddress: dummyAddress3,
        freezeAddress: dummyAddress4,
        clawbackAddress: dummyAddress5,
      };

      const result = await chainService.craftAssetCreateTx(creatorAddress, options);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(new AlgorandEncoder().decodeTransaction(result)).toStrictEqual({
        apar: {
          an: 'Asset',
          au: 'http://example.com',
          c: new AlgorandEncoder().decodeAddress(dummyAddress5),
          dc: 2,
          f: new AlgorandEncoder().decodeAddress(dummyAddress4),
          m: new AlgorandEncoder().decodeAddress(dummyAddress2),
          r: new AlgorandEncoder().decodeAddress(dummyAddress3),
          t: 1000,
          un: 'UNIT',
        },
        fee: 1000,
        fv: 1,
        gen: 'test-genesis-id',
        gh: new Uint8Array([181, 235, 45, 250, 7, 167, 122, 200, 172, 250, 22, 172]),
        lv: 1001,
        snd: new AlgorandEncoder().decodeAddress(dummyAddress1),
        type: 'acfg',
      });
    });
  });

  describe('craftPaymentTx', () => {
    it('should craft an payment transaction', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });

      // Use a valid dummy Algorand address for all address options.
      const dummyAddress1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
      const dummyAddress2 = 'MONEYMBRSMUAM2NGL6PCEQEDVHFWAQB6DU47NUS6P5DJM4OJFN7E7DSVBA';

      const result = await chainService.craftPaymentTx(dummyAddress1, dummyAddress2, 2);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(new AlgorandEncoder().decodeTransaction(result)).toStrictEqual({
        amt: 2,
        fee: 1000,
        fv: 1,
        gen: 'test-genesis-id',
        gh: new Uint8Array([181, 235, 45, 250, 7, 167, 122, 200, 172, 250, 22, 172]),
        lv: 1001,
        rcv: new AlgorandEncoder().decodeAddress(dummyAddress2),
        snd: new AlgorandEncoder().decodeAddress(dummyAddress1),
        type: 'pay',
      });
    });
  });

  describe('craftAssetTransferTx', () => {
    it('should craft asset transfer transaction', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });

      // Use a valid dummy Algorand address for all address options.
      const dummyAddress1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
      const dummyAddress2 = 'MONEYMBRSMUAM2NGL6PCEQEDVHFWAQB6DU47NUS6P5DJM4OJFN7E7DSVBA';
      const lease = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
      const leaseB64 = Buffer.from(lease).toString("base64")
      const note = "note: note"

      const result = await chainService.craftAssetTransferTx(dummyAddress1, dummyAddress2, 1234n, 2, leaseB64, note);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(new AlgorandEncoder().decodeTransaction(result)).toStrictEqual({
        aamt: 2,
        arcv: new AlgorandEncoder().decodeAddress(dummyAddress2),
        fee: 1000,
        fv: 1,
        gen: 'test-genesis-id',
        gh: new Uint8Array([181, 235, 45, 250, 7, 167, 122, 200, 172, 250, 22, 172]),
        lx: new Uint8Array(Buffer.from(lease)),
        lv: 1001,
        note: new Uint8Array(Buffer.from(note)),
        snd: new AlgorandEncoder().decodeAddress(dummyAddress1),
        type: 'axfer',
        xaid: 1234,
      });
    });

    it('if amount is zero, should not include amount in asset transfer transaction', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });

      // Use a valid dummy Algorand address for all address options.
      const dummyAddress1 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
      const dummyAddress2 = 'MONEYMBRSMUAM2NGL6PCEQEDVHFWAQB6DU47NUS6P5DJM4OJFN7E7DSVBA';

      const result = await chainService.craftAssetTransferTx(dummyAddress1, dummyAddress2, 1234n, 0);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(new AlgorandEncoder().decodeTransaction(result)).toStrictEqual({
        arcv: new AlgorandEncoder().decodeAddress(dummyAddress2),
        fee: 1000,
        fv: 1,
        gen: 'test-genesis-id',
        gh: new Uint8Array([181, 235, 45, 250, 7, 167, 122, 200, 172, 250, 22, 172]),
        lv: 1001,
        snd: new AlgorandEncoder().decodeAddress(dummyAddress1),
        type: 'axfer',
        xaid: 1234,
      });
    });
  });

  describe('craftAssetClawbackTx', () => {
    it('should craft asset clawback transaction', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });
      // Use a valid dummy Algorand address for all address options.
      const dummyAddress1 =
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
      const dummyAddress2 =
        'MONEYMBRSMUAM2NGL6PCEQEDVHFWAQB6DU47NUS6P5DJM4OJFN7E7DSVBA';
      const dummyAddress3 =
        'DMYOIEE6HAIQF5QUF4XGNBL4GUZOZF6RFQCCB2NXP35AKK2674HBILQQLA';
      const clawbackAddress = dummyAddress1;
      const senderAddress = dummyAddress2;
      const receiverAddress = dummyAddress3;
      const assetId = 1234n;
      const amount = 2n;
      const result = await chainService.craftAssetClawbackTx(
        clawbackAddress,
        senderAddress,
        receiverAddress,
        assetId,
        amount,
      );
      expect(result).toBeInstanceOf(Uint8Array);
      expect(new AlgorandEncoder().decodeTransaction(result)).toStrictEqual({
        aamt: 2,
        arcv: new AlgorandEncoder().decodeAddress(receiverAddress),
        fee: 1000,
        fv: 1,
        gen: 'test-genesis-id',
        gh: new Uint8Array([
          181, 235, 45, 250, 7, 167, 122, 200, 172, 250, 22, 172,
        ]),
        lv: 1001,
        snd: new AlgorandEncoder().decodeAddress(clawbackAddress),
        type: 'axfer',
        xaid: 1234,
        asnd: new AlgorandEncoder().decodeAddress(senderAddress),
      });
    });
    it('if amount is zero, should not include amount in asset clawback transaction', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });
      // Use a valid dummy Algorand address for all address options.
      const dummyAddress1 =
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
      const dummyAddress2 =
        'MONEYMBRSMUAM2NGL6PCEQEDVHFWAQB6DU47NUS6P5DJM4OJFN7E7DSVBA';
      const dummyAddress3 =
        'DMYOIEE6HAIQF5QUF4XGNBL4GUZOZF6RFQCCB2NXP35AKK2674HBILQQLA';
      const clawbackAddress = dummyAddress1;
      const senderAddress = dummyAddress2;
      const receiverAddress = dummyAddress3;
      const assetId = 1234n;
      const amount = 0n;
      const result = await chainService.craftAssetClawbackTx(
        clawbackAddress,
        senderAddress,
        receiverAddress,
        assetId,
        amount,
      );
      expect(result).toBeInstanceOf(Uint8Array);
      expect(new AlgorandEncoder().decodeTransaction(result)).toStrictEqual({
        arcv: new AlgorandEncoder().decodeAddress(receiverAddress),
        fee: 1000,
        fv: 1,
        gen: 'test-genesis-id',
        gh: new Uint8Array([
          181, 235, 45, 250, 7, 167, 122, 200, 172, 250, 22, 172,
        ]),
        lv: 1001,
        snd: new AlgorandEncoder().decodeAddress(clawbackAddress),
        type: 'axfer',
        xaid: 1234,
        asnd: new AlgorandEncoder().decodeAddress(senderAddress),
      });
    });
  });

  describe('getSuggestedParams', () => {
    it('should return suggested params on success', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      });

      const result = await chainService.getSuggestedParams();
      expect(result).toEqual({
        lastRound: 1n,
        minFee: 1000,
      });
    });

    it('should throw HttpErrorByCode if error has response.status', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockRejectedValue({
        response: {
          status: 400,
          text: 'Bad Request',
        },
      });

      await expect(chainService.getSuggestedParams()).rejects.toThrow('NodeException: Bad Request');
    });

    it('should throw InternalServerErrorException if error does not have response.status', async () => {
      (httpServiceMock.axiosRef.get as jest.Mock).mockRejectedValue({
        text: 'Bad Request',
      });

      await expect(chainService.getSuggestedParams()).rejects.toThrow('NodeException');
    });
  });

  describe('waitConfirmation()', () => {
    it('wait for confirmation', async () => {
      let suggested_params_response = {
        data: {
          'min-fee': 1000,
          'last-round': 1,
        },
        status: 200,
      };

      let pending_info_waiting_response = {
        data: {
          'pool-error': '',
          txn: {
            sig: 'wP+JyEmOvoU1yUvc6ZJxCj9g71/CnujhheqRbHzmhcHlpldfARAgrlcn0viSYDieG2N+Esgjk1BGiefNvCIIDQ==',
            txn: {
              fee: 1000,
              fv: 49353524,
              gen: 'testnet-v1.0',
              gh: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
              lv: 49354524,
              snd: 'QM6572ZE7I7THPY5SLHN33M2ZSBVCKDOKP6CPB4QBITIRSNJCZ5LMUBT5I',
              type: 'acfg',
            },
          },
        },
      };

      let pending_info_confirmed_response = {
        data: {
          'asset-index': 735204972,
          'confirmed-round': 49353526,
          'pool-error': '',
          txn: {
            sig: 'wP+JyEmOvoU1yUvc6ZJxCj9g71/CnujhheqRbHzmhcHlpldfARAgrlcn0viSYDieG2N+Esgjk1BGiefNvCIIDQ==',
            txn: {
              fee: 1000,
              fv: 49353524,
              gen: 'testnet-v1.0',
              gh: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
              lv: 49354524,
              snd: 'QM6572ZE7I7THPY5SLHN33M2ZSBVCKDOKP6CPB4QBITIRSNJCZ5LMUBT5I',
              type: 'acfg',
            },
          },
        },
      };

      let wait_for_block_after_response = {
        data: {},
      };

      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValueOnce(suggested_params_response);
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValueOnce(pending_info_waiting_response);
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValueOnce(wait_for_block_after_response);
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValueOnce(pending_info_waiting_response);
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValueOnce(wait_for_block_after_response);
      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValueOnce(pending_info_confirmed_response);

      const result = await chainService.waitConfirmation('VC2IXLPH4Q7PP7PVH3MTQY3XH7HA34XQLADK7FEB4O63AORY4K4Q');

      expect(result).toEqual(pending_info_confirmed_response.data);
    });
  });

  describe('submitTransaction', () => {
    it('should submit transaction and wait for confirmation', async () => {
      const txn = new Uint8Array([1, 2, 3]);
      const mockSubmitResponse = { txid: 'dummy-txid' };

      (httpServiceMock.axiosRef.post as jest.Mock).mockResolvedValue({
        data: {
          txId: 'dummy-txid',
        },
        status: 201,
      });

      chainService.waitConfirmation = jest.fn().mockResolvedValue(null);

      const result = await chainService.submitTransaction(txn);
      expect(result).toEqual(mockSubmitResponse);
    });
  });

  describe('getAccountDetail', () => {
    it('should return account detail on success', async () => {
      const publicAddress = 'dummy-address';

      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {
          address: publicAddress,
          amount: 1000,
          assets: [{"asset-id": 1}, {"asset-id": 2}],
          'min-balance': 123,
        },
        status: 201,
      });

      const result = await chainService.getAccountDetail(publicAddress);
      expect(result).toEqual({ amount: 1000n, assets: [{assetId: 1}, {assetId: 2}], minBalance: 123n } as TruncatedAccountResponse);
    });
  });

  describe('getAccountAsset', () => {
    it('should return account asset on success', async () => {
      const publicAddress = 'dummy-address';
      const assetId = 1n;

      (httpServiceMock.axiosRef.get as jest.Mock).mockResolvedValue({
        data: {},
        status: 201,
      });

      const result = await chainService.getAccountAsset(publicAddress, assetId);
      expect(result).toEqual({});
    });

    it('should throw HttpErrorByCode if error has response.status', async () => {
      const publicAddress = 'dummy-address';
      const assetId = 1n;
      (httpServiceMock.axiosRef.get as jest.Mock).mockRejectedValue({
        response: {
          status: 404,
          text: 'Not Found',
        },
      });
      const result = await chainService.getAccountAsset(publicAddress, assetId);
      expect(result).toEqual(null);
    });

    it('should throw InternalServerErrorException if error does not have response.status here', async () => {
      const publicAddress = 'dummy-address';
      const assetId = 1n;
      (httpServiceMock.axiosRef.get as jest.Mock).mockRejectedValue({
        response: {
          status: 501,
          text: 'Internal',
        },
      });

      await expect(chainService.getAccountAsset(publicAddress, assetId)).rejects.toThrow('NodeException');
    });
  });
});
