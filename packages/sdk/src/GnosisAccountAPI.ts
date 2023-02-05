import { BigNumber, BigNumberish } from 'ethers'
import {
  GnosisSafe,
  GnosisSafe__factory, GnosisSafeAccountFactory,
  GnosisSafeAccountFactory__factory,
  EIP4337Manager__factory,
} from '@zerodevapp/contracts'

import { arrayify, hexConcat } from 'ethers/lib/utils'
import { Signer } from '@ethersproject/abstract-signer'
import { BaseApiParams, BaseAccountAPI } from './BaseAccountAPI'

/**
 * constructor params, added on top of base params:
 * @param owner the signer object for the account owner
 * @param index nonce value used when creating multiple accounts for the same owner
 * @param factoryAddress address of factory to deploy new contracts (not needed if account already deployed)
 */
export interface GnosisAccountApiParams extends BaseApiParams {
  owner: Signer
  index?: number
  factoryAddress?: string
}

/**
 * An implementation of the BaseAccountAPI using Gnosis Safe.
 * - Pass "owner" address and "index" nonce to the factory
 * - owner signs requests using normal "Ethereum Signed Message" (ether's signer.signMessage())
 * - nonce is a public variable "nonce"
 * - execute method is "execTransactionFromModule()", since the entrypoint is set as a module
 */
export class GnosisAccountAPI extends BaseAccountAPI {
  factoryAddress?: string
  owner: Signer
  index: number

  accountContract?: GnosisSafe
  factory?: GnosisSafeAccountFactory

  constructor(params: GnosisAccountApiParams) {
    super(params)
    this.factoryAddress = params.factoryAddress
    this.owner = params.owner
    this.index = params.index ?? 0
  }

  async _getAccountContract(): Promise<GnosisSafe> {
    if (this.accountContract == null) {
      this.accountContract = GnosisSafe__factory.connect(await this.getAccountAddress(), this.provider)
    }
    return this.accountContract
  }

  /**
   * return the value to put into the "initCode" field, if the account is not yet deployed.
   * this value holds the "factory" address, followed by this account's information
   */
  async getAccountInitCode(): Promise<string> {
    const ownerAddress = await this.owner.getAddress()

    // Very hacky code... we will remove this as soon as we migrate these users
    // The last one is my own derek@zerodev.app address for testing
    for (let addr of ['0x0d68adA5ba372a508Cd76f46000292028E64B1f8', '0xd19B624010d6bd0223658059Ac892514e41676B7', '0x7AeCA2dFf97B9692E17a1fa64E42d527179624d3', '0x3cE0223eDBfA89eCDf9Dc85abB3d1b7361B24354']) {
      if (addr.toLowerCase() == ownerAddress.toLowerCase()) {
        this.factoryAddress = '0x5d7a58eFbC95f5b3Da446D9496D73a6E9D57b0a4'
      }
    }

    if (this.factory == null) {
      if (this.factoryAddress != null && this.factoryAddress !== '') {
        this.factory = GnosisSafeAccountFactory__factory.connect(this.factoryAddress, this.provider)
      } else {
        throw new Error('no factory to get initCode')
      }
    }
    return hexConcat([
      this.factory.address,
      this.factory.interface.encodeFunctionData('createAccount', [ownerAddress, this.index])
    ])
  }

  async getNonce(): Promise<BigNumber> {
    if (await this.checkAccountPhantom()) {
      return BigNumber.from(0)
    }
    const accountContract = await this._getAccountContract()
    return await accountContract.nonce()
  }

  /**
   * encode a method call from entryPoint to our contract
   * @param target
   * @param value
   * @param data
   */
  async encodeExecute(target: string, value: BigNumberish, data: string): Promise<string> {
    const accountContract = await this._getAccountContract()

    // the executeAndRevert method is defined on the manager
    const managerContract = EIP4337Manager__factory.connect(accountContract.address, accountContract.provider)
    return managerContract.interface.encodeFunctionData(
      'executeAndRevert',
      [
        target,
        value,
        data,
        0,
      ])
  }

  /**
   * encode a method call from entryPoint to our contract
   * @param target
   * @param value
   * @param data
   */
  async encodeExecuteDelegate(target: string, value: BigNumberish, data: string): Promise<string> {
    const accountContract = await this._getAccountContract()

    // the executeAndRevert method is defined on the manager
    const managerContract = EIP4337Manager__factory.connect(accountContract.address, accountContract.provider)
    return managerContract.interface.encodeFunctionData(
      'executeAndRevert',
      [
        target,
        value,
        data,
        1,
      ])
  }

  async signUserOpHash(userOpHash: string): Promise<string> {
    return await this.owner.signMessage(arrayify(userOpHash))
  }
}
