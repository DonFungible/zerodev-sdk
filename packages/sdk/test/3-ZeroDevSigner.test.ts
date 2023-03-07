import { SampleRecipient, SampleRecipient__factory } from '@account-abstraction/utils/dist/src/types'
import { ethers } from 'hardhat'
import { ZeroDevProvider, ZeroDevSigner } from '../src'
import { hexConcat, hexZeroPad, resolveProperties } from 'ethers/lib/utils'
import {
  EntryPoint, EntryPoint__factory,
  GnosisSafeProxyFactory,
  GnosisSafeProxyFactory__factory,
  MultiSend__factory,
  ERC721SubscriptionModule,
  ERC721SubscriptionModule__factory,
  SampleNFT,
  SampleNFT__factory,
  ZeroDevPluginSafe,
  ZeroDevGnosisSafeAccountFactory,
  ZeroDevPluginSafe__factory,
  ZeroDevGnosisSafeAccountFactory__factory,
} from '@zerodevapp/contracts'
import { expect } from 'chai'
import { parseEther, hexValue } from 'ethers/lib/utils'
import { BigNumber, Signer, utils, Wallet } from 'ethers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { ClientConfig } from '../src/ClientConfig'
import { wrapProvider } from '../src/Provider'
import { DeterministicDeployer } from '../src/DeterministicDeployer'

const provider = ethers.provider
const signer = provider.getSigner()
const deployer = new DeterministicDeployer(ethers.provider)

describe('ZeroDevSigner, Provider', function () {
  let recipient: SampleRecipient
  let aaProvider: ZeroDevProvider
  let entryPoint: EntryPoint
  let proxyFactory: GnosisSafeProxyFactory
  let safeSingleton: ZeroDevPluginSafe
  let accountFactory: ZeroDevGnosisSafeAccountFactory

  // create an AA provider for testing that bypasses the bundler
  let createTestAAProvider = async ( owner: Signer, address?: string): Promise<ZeroDevProvider> => {
    const config: ClientConfig = {
      entryPointAddress: entryPoint.address,
      accountFactoryAddress: accountFactory.address,
      walletAddress: address,
      bundlerUrl: ''
    }
    const aaProvider = await wrapProvider(provider, config, owner)

    const beneficiary = provider.getSigner().getAddress()
    // for testing: bypass sending through a bundler, and send directly to our entrypoint..
    aaProvider.httpRpcClient.sendUserOpToBundler = async (userOp) => {
      try {
        await entryPoint.handleOps([userOp], beneficiary)
      } catch (e: any) {
        // doesn't report error unless called with callStatic
        await entryPoint.callStatic.handleOps([userOp], beneficiary).catch((e: any) => {
          // eslint-disable-next-line
          const message = e.errorArgs != null ? `${e.errorName}(${e.errorArgs.join(',')})` : e.message
          throw new Error(message)
        })
      }
      return ''
    }

    aaProvider.httpRpcClient.estimateUserOpGas = async (userOp) => {
      const op = {
        ...await resolveProperties(userOp),
        // default values for missing fields.
        paymasterAndData: '0x',
        signature: '0x'.padEnd(66 * 2, '1b'), // TODO: each wallet has to put in a signature in the correct length
        maxFeePerGas: 0,
        maxPriorityFeePerGas: 0,
        preVerificationGas: 0,
        verificationGasLimit: 10e6
      }
      const callGasLimit = await provider.estimateGas({
        from: entryPoint.address,
        to: userOp.sender,
        data: userOp.callData
      }).then(b => b.toNumber())

      return {
        preVerificationGas: "1000000",
        verificationGas: "1000000",
        callGasLimit: callGasLimit.toString(),
        validUntil: 0,
        validAfter: 0
      }
    }
    return aaProvider
  }

  describe('wallet created with zerodev', function(){
    before('init', async () => {
      const deployRecipient = await new SampleRecipient__factory(signer).deploy()
      entryPoint = await new EntryPoint__factory(signer).deploy()
      // standard safe singleton contract (implementation)
      safeSingleton = await new ZeroDevPluginSafe__factory(signer).deploy(entryPoint.address)
      // standard safe proxy factory
      proxyFactory = await new GnosisSafeProxyFactory__factory(signer).deploy()
  
      accountFactory = await new ZeroDevGnosisSafeAccountFactory__factory(signer)
        .deploy(proxyFactory.address, safeSingleton.address)
      const aasigner = Wallet.createRandom()
  
      aaProvider = await createTestAAProvider(aasigner)
      recipient = deployRecipient.connect(aaProvider.getSigner())
    })
  
    it('should fail to send before funding', async () => {
      try {
        await recipient.something('hello', { gasLimit: 1e6 })
        throw new Error('should revert')
      } catch (e: any) {
        expect(e.message).to.eq('FailedOp(0,AA21 didn\'t pay prefund)')
      }
    })
  
    it('should use ERC-4337 Signer and Provider to send the UserOperation to the bundler', async function () {
      const accountAddress = await aaProvider.getSigner().getAddress()
      await signer.sendTransaction({
        to: accountAddress,
        value: parseEther('0.1')
      })
  
      const ret = await recipient.something('hello')
      await expect(ret).to.emit(recipient, 'Sender')
        .withArgs(anyValue, accountAddress, 'hello')
    })
  
    it('should batch call', async function () {
      // Deterministically deploy MultiSend
      const deployer = new DeterministicDeployer(ethers.provider)
      const ctr = hexValue(new MultiSend__factory(ethers.provider.getSigner()).getDeployTransaction().data!)
      DeterministicDeployer.init(ethers.provider)
      const addr = await DeterministicDeployer.getAddress(ctr)
      await DeterministicDeployer.deploy(ctr)
      expect(await deployer.isContractDeployed(addr)).to.equal(true)
  
      const signer = aaProvider.getSigner()
      const accountAddress = await signer.getAddress()
  
      const calls = [
        {
          to: recipient.address,
          data: recipient.interface.encodeFunctionData('something', ['hello']),
        },
        {
          to: recipient.address,
          data: recipient.interface.encodeFunctionData('something', ['world']),
        },
      ]
  
      const ret = await signer.execBatch(calls, {multiSendAddress: addr})
  
      await expect(ret).to.emit(recipient, 'Sender')
        .withArgs(anyValue, accountAddress, 'hello')
      await expect(ret).to.emit(recipient, 'Sender')
        .withArgs(anyValue, accountAddress, 'world')
    })
  
    it('should use ERC-4337 for delegate call', async function () {
      const signer = aaProvider.getSigner()
      const accountAddress = await signer.getAddress()
      const delegateRecipient = recipient.connect(signer.delegateCopy())
  
      // in a delegate call, the we should find the event emitted by the account itself
      const tx = await delegateRecipient.something('hello')
      const receipt = await tx.wait()
      const events = receipt.events!.filter(
        (e) => e.address === accountAddress,
      )
      let decodedEvent: any
      for (const event of events) {
        try {
          decodedEvent = recipient.interface.decodeEventLog(
            'Sender',
            event.data,
            event.topics,
          )
        } catch (e) {
        }
      }
  
      expect(decodedEvent!.message).to.equal('hello')
    })
  
    it('should revert if on-chain userOp execution reverts', async function () {
      // specifying gas, so that estimateGas won't revert..
      const ret = await recipient.reverting({ gasLimit: 20000 })
  
      try {
        await ret.wait()
        throw new Error('expected to revert')
      } catch (e: any) {
        expect(e.message).to.match(/test revert/)
      }
    })
  
    context('#modules', () => {
  
      let module: ERC721SubscriptionModule
      let erc721Collection: SampleNFT
      let userAASigner: ZeroDevSigner
      let userAddr: string
      let senderSigner: Signer
      const price = ethers.utils.parseEther('1')
      const period = 60 // seconds
  
      before(async () => {
        userAASigner = aaProvider.getSigner()
        userAddr = await userAASigner.getAddress()
        senderSigner = provider.getSigner(1)
  
        erc721Collection = await new SampleNFT__factory(signer).deploy()
  
        module = await new ERC721SubscriptionModule__factory(signer).deploy(
          erc721Collection.address,
          senderSigner.getAddress(),
          price,
          period,
        )
  
      })
  
      it('should enable module', async () => {
        await userAASigner.enableModule(module.address)
      })
  
      it('should send payment when receiving NFT', async () => {
        const tokenId = 0
  
        // mint an NFT to sender
        await erc721Collection.mint(senderSigner.getAddress())
  
        // approve the NFT for transfer
        await erc721Collection.connect(senderSigner).approve(module.address, tokenId)
  
        // payment should fail if the user does not have enough funds
        try {
          const ret = await module.triggerPayment(userAddr, tokenId, {
            gasLimit: 1e6,
          })
          await ret.wait()
          throw new Error('expected to revert')
        } catch (e: any) {
          expect(e.message).to.match(/Payment failed/)
        }
  
        // send the user enough funds to trigger multiple payments
        await signer.sendTransaction({
          to: userAddr,
          value: price.mul(10),
        })
        const oldUserBalance = await userAASigner.getBalance()
        const oldSenderBalance = await senderSigner.getBalance()
  
        // try triggering payment again
        await module.triggerPayment(userAddr, tokenId)
        const newUserBalance = await userAASigner.getBalance()
        const newSenderBalance = await senderSigner.getBalance()
  
        // check that the user's balance has decreased by the payment amount
        expect(newUserBalance).to.equal(oldUserBalance.sub(price))
  
        // check that the sender has received the ETH
        expect(newSenderBalance).to.equal(oldSenderBalance.add(price))
  
        // check that the user has received the NFT
        expect(await erc721Collection.ownerOf(tokenId)).to.equal(await userAASigner.getAddress())
      })
  
      it('should not be able to trigger payment again before the subscription period has passed', async () => {
        const tokenId = 1
  
        // mint an NFT to sender
        await erc721Collection.mint(senderSigner.getAddress())
  
        // approve the NFT for transfer
        await erc721Collection.connect(senderSigner).approve(module.address, tokenId)
  
        try {
          const ret = await module.triggerPayment(userAddr, tokenId, {
            gasLimit: 1e6,
          })
          await ret.wait()
          throw new Error('expected to revert')
        } catch (e: any) {
          console.log(e.message)
          expect(e.message).to.match(/Payment period has not elapsed/)
        }
  
        // increase hardhat block timestamp
        await provider.send("evm_increaseTime", [period])
  
        const oldUserBalance = await userAASigner.getBalance()
        const oldSenderBalance = await senderSigner.getBalance()
  
        // try triggering payment again
        await module.triggerPayment(userAddr, tokenId)
        const newUserBalance = await userAASigner.getBalance()
        const newSenderBalance = await senderSigner.getBalance()
  
        // check that the user's balance has decreased by the payment amount
        expect(newUserBalance).to.equal(oldUserBalance.sub(price))
  
        // check that the sender has received the ETH
        expect(newSenderBalance).to.equal(oldSenderBalance.add(price))
  
        // check that the user has received the NFT
        expect(await erc721Collection.ownerOf(tokenId)).to.equal(userAddr)
      })
    })


  })

  describe('predeployed wallets', function(){
    let aasigner: Signer;
    before('init', async () => {
      const deployRecipient = await new SampleRecipient__factory(signer).deploy()
      aasigner = Wallet.createRandom()

      const wallet = await accountFactory.createAccount(await aasigner.getAddress(), 1).then( async (x) => await x.wait()).then( x => x.events?.find( x => x.event === 'AccountCreated')?.args?.account);
      console.log(wallet);
      aaProvider = await createTestAAProvider(aasigner, wallet);
      recipient = deployRecipient.connect(aaProvider.getSigner())
    })

    it("should return proper address", async function(){
      const addr = await aaProvider.getSigner().getAddress();
      expect(addr).to.equal(await accountFactory.getAddress(await aasigner.getAddress(), 1));
    })
  
    it('should fail to send before funding', async () => {
      try {
        await recipient.something('hello', { gasLimit: 1e6 })
        throw new Error('should revert')
      } catch (e: any) {
        expect(e.message).to.eq('FailedOp(0,AA21 didn\'t pay prefund)')
      }
    })
  
    it('should use ERC-4337 Signer and Provider to send the UserOperation to the bundler', async function () {
      const accountAddress = await aaProvider.getSigner().getAddress()
      await signer.sendTransaction({
        to: accountAddress,
        value: parseEther('0.1')
      })
  
      const ret = await recipient.something('hello')
      await expect(ret).to.emit(recipient, 'Sender')
        .withArgs(anyValue, accountAddress, 'hello')
    })
  
    it('should batch call', async function () {
      // Deterministically deploy MultiSend
      const deployer = new DeterministicDeployer(ethers.provider)
      const ctr = hexValue(new MultiSend__factory(ethers.provider.getSigner()).getDeployTransaction().data!)
      DeterministicDeployer.init(ethers.provider)
      const addr = await DeterministicDeployer.getAddress(ctr)
      await DeterministicDeployer.deploy(ctr)
      expect(await deployer.isContractDeployed(addr)).to.equal(true)
  
      const signer = aaProvider.getSigner()
      const accountAddress = await signer.getAddress()
  
      const calls = [
        {
          to: recipient.address,
          data: recipient.interface.encodeFunctionData('something', ['hello']),
        },
        {
          to: recipient.address,
          data: recipient.interface.encodeFunctionData('something', ['world']),
        },
      ]
  
      const ret = await signer.execBatch(calls, {multiSendAddress: addr})
  
      await expect(ret).to.emit(recipient, 'Sender')
        .withArgs(anyValue, accountAddress, 'hello')
      await expect(ret).to.emit(recipient, 'Sender')
        .withArgs(anyValue, accountAddress, 'world')
    })
  
    it('should use ERC-4337 for delegate call', async function () {
      const signer = aaProvider.getSigner()
      const accountAddress = await signer.getAddress()
      const delegateRecipient = recipient.connect(signer.delegateCopy())
  
      // in a delegate call, the we should find the event emitted by the account itself
      const tx = await delegateRecipient.something('hello')
      const receipt = await tx.wait()
      const events = receipt.events!.filter(
        (e) => e.address === accountAddress,
      )
      let decodedEvent: any
      for (const event of events) {
        try {
          decodedEvent = recipient.interface.decodeEventLog(
            'Sender',
            event.data,
            event.topics,
          )
        } catch (e) {
        }
      }
  
      expect(decodedEvent!.message).to.equal('hello')
    })
  
    it('should revert if on-chain userOp execution reverts', async function () {
      // specifying gas, so that estimateGas won't revert..
      const ret = await recipient.reverting({ gasLimit: 20000 })
  
      try {
        await ret.wait()
        throw new Error('expected to revert')
      } catch (e: any) {
        expect(e.message).to.match(/test revert/)
      }
    })
  
    context('#modules', () => {
  
      let module: ERC721SubscriptionModule
      let erc721Collection: SampleNFT
      let userAASigner: ZeroDevSigner
      let userAddr: string
      let senderSigner: Signer
      const price = ethers.utils.parseEther('1')
      const period = 60 // seconds
  
      before(async () => {
        userAASigner = aaProvider.getSigner()
        userAddr = await userAASigner.getAddress()
        senderSigner = provider.getSigner(1)
  
        erc721Collection = await new SampleNFT__factory(signer).deploy()
  
        module = await new ERC721SubscriptionModule__factory(signer).deploy(
          erc721Collection.address,
          senderSigner.getAddress(),
          price,
          period,
        )
  
      })
  
      it('should enable module', async () => {
        await userAASigner.enableModule(module.address)
      })
  
      it('should send payment when receiving NFT', async () => {
        const tokenId = 0
  
        // mint an NFT to sender
        await erc721Collection.mint(senderSigner.getAddress())
  
        // approve the NFT for transfer
        await erc721Collection.connect(senderSigner).approve(module.address, tokenId)
  
        // payment should fail if the user does not have enough funds
        try {
          const ret = await module.triggerPayment(userAddr, tokenId, {
            gasLimit: 1e6,
          })
          await ret.wait()
          throw new Error('expected to revert')
        } catch (e: any) {
          expect(e.message).to.match(/Payment failed/)
        }
  
        // send the user enough funds to trigger multiple payments
        await signer.sendTransaction({
          to: userAddr,
          value: price.mul(10),
        })
        const oldUserBalance = await userAASigner.getBalance()
        const oldSenderBalance = await senderSigner.getBalance()
  
        // try triggering payment again
        await module.triggerPayment(userAddr, tokenId)
        const newUserBalance = await userAASigner.getBalance()
        const newSenderBalance = await senderSigner.getBalance()
  
        // check that the user's balance has decreased by the payment amount
        expect(newUserBalance).to.equal(oldUserBalance.sub(price))
  
        // check that the sender has received the ETH
        expect(newSenderBalance).to.equal(oldSenderBalance.add(price))
  
        // check that the user has received the NFT
        expect(await erc721Collection.ownerOf(tokenId)).to.equal(await userAASigner.getAddress())
      })
  
      it('should not be able to trigger payment again before the subscription period has passed', async () => {
        const tokenId = 1
  
        // mint an NFT to sender
        await erc721Collection.mint(senderSigner.getAddress())
  
        // approve the NFT for transfer
        await erc721Collection.connect(senderSigner).approve(module.address, tokenId)
  
        try {
          const ret = await module.triggerPayment(userAddr, tokenId, {
            gasLimit: 1e6,
          })
          await ret.wait()
          throw new Error('expected to revert')
        } catch (e: any) {
          console.log(e.message)
          expect(e.message).to.match(/Payment period has not elapsed/)
        }
  
        // increase hardhat block timestamp
        await provider.send("evm_increaseTime", [period])
  
        const oldUserBalance = await userAASigner.getBalance()
        const oldSenderBalance = await senderSigner.getBalance()
  
        // try triggering payment again
        await module.triggerPayment(userAddr, tokenId)
        const newUserBalance = await userAASigner.getBalance()
        const newSenderBalance = await senderSigner.getBalance()
  
        // check that the user's balance has decreased by the payment amount
        expect(newUserBalance).to.equal(oldUserBalance.sub(price))
  
        // check that the sender has received the ETH
        expect(newSenderBalance).to.equal(oldSenderBalance.add(price))
  
        // check that the user has received the NFT
        expect(await erc721Collection.ownerOf(tokenId)).to.equal(userAddr)
      })
    })  
  })
})