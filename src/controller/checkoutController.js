const User = require("../model/userSchema");
const Cart = require("../model/cartSchema");
const Order = require("../model/orderSchema");
const Address = require("../model/addressSchema");
const Product = require("../model/productSchema");
const Payment = require("../model/paymentSchema");
const Wallet = require("../model/walletSchema");
const Coupon = require("../model/couponSchema");
const Ledger = require("../model/ledgerSchema");

const mongoose = require("mongoose");
require("dotenv").config();

// Razorpay
const Razorpay = require("razorpay");
const crypto = require("crypto");

var instance = new Razorpay({
  key_id: process.env.RAZ_KEY_ID,
  key_secret: process.env.RAZ_KEY_SECRET,
});

// Function to check if a product exists and is active
const checkProductExistence = async (cartItem) => {
  const product = await Product.findById(cartItem.product_id._id);
  if (!product || !product.isActive) {
    throw new Error(`${product.product_name}`);
  }
  return product;
};

// Function to check if the stock is sufficient for a productExistencePromisesproduct
const checkStockAvailability = async (cartItem) => {
  const product = await Product.findById(cartItem.product_id._id);
  const variant = product.variants.find(
    (variant) => variant._id.toString() === cartItem.variant.toString()
  );
  if (variant.stock < cartItem.quantity) {
    throw new Error(`${product.product_name}`);
  }
  return product;
};

async function assignUniqueOrderIDs(items) {
  for (const item of items) {
    let isUnique = false;
    while (!isUnique) {
      const generatedOrderID = generateOrderID();
      const existingOrder = await Order.findOne({
        "items.orderID": generatedOrderID,
      });
      if (!existingOrder) {
        item.orderID = generatedOrderID;
        isUnique = true;
      }
    }
  }
}

let orderCounter = 0;

function generateOrderID() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2); // Last two digits of the year
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // Month as two digits
  const day = date.getDate().toString().padStart(2, "0"); // Day as two digits

  // Increment and format the counter part
  orderCounter = (orderCounter + 1) % 1000; // Resets every 1000
  const counterPart = orderCounter.toString().padStart(3, "0");

  return `ODR${year}${month}${day}${counterPart}`;
}

// Get Checkout page
// check coupon if valid apply
// Payment and Stuff

const createRazorpayOrder = async (order_id, total) => {
  let options = {
    amount: total * 100, // amount in the smallest currency unit
    currency: "INR",
    receipt: order_id.toString(),
  };
  const order = await instance.orders.create(options);

  return order;
};

module.exports = {
  getCheckout: async (req, res) => {
    const locals = {
      title: "E-Shopee - Checkout",
    };

    console.log("Checkout req ", req.user);
    let orderStatus = "";

    if (!req.isAuthenticated()) {
      return res.redirect("/login");
    }

    const userCart = await Cart.findOne({ userId: req.user.id }).populate(
      "items.product_id items.color items.size coupon"
    );
    if (!userCart) {
      return res.redirect("/user/cart");
    }
    if (!userCart.items.length > 0) {
      return res.redirect("/user/cart");
    }

    let user = await User.findById(req.user.id);

    // Correctly use map with async functions
    const productExistencePromises = userCart.items.map((item) =>
      checkProductExistence(item)
    );
    const productExistenceResults = await Promise.allSettled(
      productExistencePromises
    );

    // Filter out the rejected promises to identify which items are not valid
    const invalidCartItems = productExistenceResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);

    if (invalidCartItems.length > 0) {
      console.log(invalidCartItems);
      req.flash(
        "error",
        `The following items are not available: ${invalidCartItems
          .join(", ")
          .replaceAll("Error:", "")}`
      );

      return res.redirect("/user/cart");
    }

    // Correctly use map with async functions
    const stockAvailabilityPromises = userCart.items.map((item) =>
      checkStockAvailability(item)
    );
    const stockAvailabilityResults = await Promise.allSettled(
      stockAvailabilityPromises
    );

    // Filter out the rejected promises to identify which items have insufficient stock
    const insufficientStockItems = stockAvailabilityResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);

    if (insufficientStockItems.length > 0) {
      console.log(insufficientStockItems);
      req.flash(
        "error",
        `Insufficient stock for the following items: ${insufficientStockItems
          .join(", ")
          .replaceAll("Error: ", "")}`
      );

      return res.redirect("/user/cart");
    }

    const address = await Address.find({
      customer_id: req.user.id,
      delete: false,
    });

    let totalPrice = 0;
    let totalPriceBeforeOffer = 0;
    for (const prod of userCart.items) {
      prod.price = prod.product_id.onOffer
        ? prod.product_id.offerDiscountPrice
        : prod.product_id.sellingPrice;

      const itemTotal = prod.price * prod.quantity;
      prod.itemTotal = itemTotal;
      totalPrice += itemTotal;
      totalPriceBeforeOffer += prod.price;
    }

    totalPrice += userCart.deliveryCharge;

    // for (let prod of userCart.items) {
    //   prod.price = prod.product_id.sellingPrice * prod.quantity;
    //   totalPrice += prod.price; // Calculate total price
    // }

    // Apply coupon discount if applicable
    let couponDiscount = 0;
    if (userCart.coupon) {
      const coupon = await Coupon.findById(userCart.coupon);

      if (
        coupon &&
        coupon.isActive &&
        new Date() <= coupon.expirationDate &&
        totalPrice >= coupon.minPurchaseAmount
      ) {
        couponDiscount = totalPrice * (coupon.rateOfDiscount / 100);
        totalPrice -= couponDiscount;
        totalPrice = Math.round(totalPrice);
      } else {
        // If the total is less than the minimum purchase amount, remove the coupon
        userCart.coupon = undefined;
        userCart.couponDiscount = 0;
        await userCart.save();
      }
    }

    // Update the cart's total price and coupon discount in the database
    userCart.totalPrice = totalPriceBeforeOffer;
    userCart.payable = totalPrice;
    userCart.couponDiscount = couponDiscount;
    console.log(userCart);
    await userCart.save();

    // Correctly calculate cartCount
    let cartCount = userCart.items.length;

    const coupons = await Coupon.find({
      isActive: true,
      // minPurchaseAmount: { $lte: totalPriceBeforeOffer },
      expirationDate: { $gte: Date.now() },
      // usedBy: [{ $: req.user.id }],
    });
    // console.log("coupons", coupons);

    let userWallet = await Wallet.findOne({ userId: req.user.id });

    if (!userWallet) {
      userWallet = {
        balance: 0,
        transactions: [],
        isInsufficient: true,
      };
    }

    let isCOD = true;

    if (totalPrice > 1000) {
      isCOD = false;
    }

    if (totalPrice > userWallet.balance) {
      userWallet.isInsufficient = true;
    } else {
      userWallet.isInsufficient = false;
    }

    res.render("shop/checkout", {
      locals,
      user,
      address,
      userCart,
      isCOD,
      cartList: userCart.items,
      deliveryCharge: userCart.deliveryCharge,
      cartCount,
      coupons,
      totalPrice,
      couponDiscount,
      wallet: userWallet,
      checkout: true,
      orderStatus,
    });
  },

  // place order
  placeOrder: async (req, res) => {
    try {
      let { paymentMethod, address, orderStatus, orderID } = req.body;

      console.log(orderID);
      orderID = orderID.toString();

      const user = await User.findById(req.user.id).catch((error) => {
        console.error(error);
        return res.status(500).json({ error: "Failed to find user" });
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      if (orderStatus === "Failed") {
        let order = await Order.findOne({ _id: orderID }).populate(
          "customer_id items.product_id items.color items.size shippingAddress coupon"
        );
        console.log("order ", order);
        switch (paymentMethod) {
          case "COD":
            if (!order) {
              return res.status(500).json({ error: "order not found" });
            }

            // reduce stock of the variant

            // const product = await Product.findById(order.product_id);
            for (const item of order.items) {
              const product = await Product.findById(item.product_id).catch(
                (error) => {
                  console.error(error);
                  return res
                    .status(500)
                    .json({ error: "Failed to find product" });
                }
              );

              if (!product) {
                return res.status(404).json({ error: "Product not found" });
              }

              const variantIndex = product.variants.findIndex(
                (variant) => variant._id.toString() === item.variant.toString()
              );

              if (variantIndex === -1) {
                return res.status(404).json({ error: "Variant not found" });
              }

              console.log(product.variants[variantIndex]);

              product.variants[variantIndex].stock -= item.quantity;

              await product.save().catch((error) => {
                console.error(error);
                return res
                  .status(500)
                  .json({ error: "Failed to update product stock" });
              });
            }

            updateOrder = await Order.updateOne(
              { _id: orderID },
              {
                $set: {
                  "items.$[].status": "Confirmed",
                  "items.$[].paymentStatus": "Paid",
                  status: "Confirmed",
                  paymentStatus: "Paid",
                },
              }
            );

            try {
              // Fetch the current balance from the Ledger
              const ledger = await Ledger.findOne({}); // Assuming only one ledger document

              // Check if the ledger was found
              if (!ledger) {
                throw new Error("Ledger not found");
              }

              // Calculate the new balance
              const newBalance = ledger.balance + order.payable;

              // Update the Ledger document
              await Ledger.updateOne(
                {}, // No filter needed since there's only one ledger
                {
                  $inc: { balance: order.payable },
                  $push: {
                    transactions: {
                      date: new Date(),
                      amount: order.payable,
                      message: "Product Sold",
                      type: "Credit",
                      cBalance: newBalance, // Add cBalance to the transaction
                    },
                  },
                }
              );

              console.log("Update successful");
            } catch (error) {
              console.error("Error updating ledger:", error);
            }

            return res.status(200).json({
              success: true,
              message: "Order has been placed successfully.",
            });

            break;

          case "Online":
            let total = parseInt(order.payable);
            let order_id = order._id;

            const RazorpayOrder = await createRazorpayOrder(
              order_id,
              total
            ).then((order) => order);

            const timestamp = RazorpayOrder.created_at;
            const date = new Date(timestamp * 1000); // Convert the Unix timestamp to milliseconds

            // Format the date and time
            const formattedDate = date.toISOString();

            //creating a instance for payment details
            let payment = new Payment({
              payment_id: RazorpayOrder.id,
              amount: parseInt(RazorpayOrder.amount) / 100,
              currency: RazorpayOrder.currency,
              order_id: order_id,
              status: RazorpayOrder.status,
              created_at: formattedDate,
            });

            //saving in to db
            await payment.save();

            return res.json({
              status: true,
              order: RazorpayOrder,
              user,
            });

            break;

          case "Wallet":
            if (order) {
              let wallet = await Wallet.findOne({ userId: req.user.id });

              wallet.balance =
                parseInt(wallet.balance) - parseInt(order.payable);

              wallet.transactions.push({
                date: new Date(),
                amount: parseInt(order.payable),
                message: "Order placed successfully",
                type: "Debit",
              });

              await wallet.save();
              try {
                // Fetch the current balance from the Ledger
                const ledger = await Ledger.findOne({}); // Assuming only one ledger document

                // Check if the ledger was found
                if (!ledger) {
                  throw new Error("Ledger not found");
                }

                // Calculate the new balance
                const newBalance = ledger.balance + order.payable;

                // Update the Ledger document
                await Ledger.updateOne(
                  {}, // No filter needed since there's only one ledger
                  {
                    $inc: { balance: order.payable },
                    $push: {
                      transactions: {
                        date: new Date(),
                        amount: order.payable,
                        message: "Product Sold",
                        type: "Credit",
                        cBalance: newBalance, // Add cBalance to the transaction
                      },
                    },
                  }
                );

                console.log("Update successful");
              } catch (error) {
                console.error("Error updating ledger:", error);
              }

              // reduce stock of the variant
              for (const item of order.items) {
                const product = await Product.findById(item.product_id).catch(
                  (error) => {
                    console.error(error);
                    return res
                      .status(500)
                      .json({ error: "Failed to find product" });
                  }
                );

                if (!product) {
                  return res.status(404).json({ error: "Product not found" });
                }

                const variantIndex = product.variants.findIndex(
                  (variant) =>
                    variant._id.toString() === item.variant.toString()
                );

                if (variantIndex === -1) {
                  return res.status(404).json({ error: "Variant not found" });
                }

                console.log(product.variants[variantIndex]);

                product.variants[variantIndex].stock -= item.quantity;

                await product.save().catch((error) => {
                  console.error(error);
                  return res
                    .status(500)
                    .json({ error: "Failed to update product stock" });
                });
              }

              order.status = "Confirmed";
              order.items.forEach((item) => {
                item.status = "Confirmed";
              });

              await order.save();

              return res.status(200).json({
                success: true,
                message: "Order has been placed successfully.",
              });
            }

            break;

          default:
            return res.status(400).json({ error: "Invalid payment method" });
        }
      } else {
        let shippingAddress = await Address.findOne({
          _id: address,
        });

        shippingAddress = {
          _id: address,
          name: shippingAddress.name,
          house_name: shippingAddress.house_name,
          locality: shippingAddress.locality,
          area_street: shippingAddress.area_street,
          phone: shippingAddress.phone,
          address: shippingAddress.address,
          landmark: shippingAddress.landmark,
          city: shippingAddress.city,
          state: shippingAddress.state,
          zipcode: shippingAddress.zipcode,
          address: `${shippingAddress.name}, ${shippingAddress.house_name}(H),  ${shippingAddress.locality}, ${shippingAddress.town}, ${shippingAddress.state}, PIN: ${shippingAddress.zipcode}. PH: ${shippingAddress.phone}`,
        };

        if (!req.body.address) {
          return res
            .status(400)
            .json({ status: false, message: "Please add the address" });
        }
        if (!req.body.paymentMethod) {
          return res
            .status(400)
            .json({ status: false, message: "Please select a payment method" });
        }

        let userCart = await Cart.findOne({ userId: user._id }).catch(
          (error) => {
            console.error(error);
            return res
              .status(500)
              .json({ error: "Failed to find user's cart" });
          }
        );

        if (!userCart) {
          return res.status(404).json({ error: "User's cart not found" });
        }
        const status =
          paymentMethod == "COD" || paymentMethod == "Wallet"
            ? "Confirmed"
            : "Pending";
        const paymentStatus =
          paymentMethod == "COD" || paymentMethod == "Wallet"
            ? "Paid"
            : "Pending";

        // console.log(userCart.items);
        let discount = 0;

        userCart.items.forEach((item) => {
          console.log(item);
        });

        console.log("discount ", discount);

        let order;

        if (userCart.coupon) {
          order = new Order({
            customer_id: user._id,
            items: userCart.items,
            totalPrice: userCart.totalPrice,
            coupon: userCart.coupon,
            couponDiscount: userCart.couponDiscount,
            payable: userCart.payable,
            paymentMethod,
            paymentStatus,
            status,
            shippingAddress,
            discount,
          });

          order.items.forEach((item) => {
            item.status = status;
          });
        } else {
          order = new Order({
            customer_id: user._id,
            items: userCart.items,
            totalPrice: userCart.totalPrice,
            payable: userCart.payable,
            paymentMethod,
            paymentStatus,
            status,
            shippingAddress,
            discount,
          });
        }
        order.items.forEach((item) => {
          item.status = status;
        });
        // order.status = paymentMethod == "COD" ? "Confirmed" : "Pending";
        await assignUniqueOrderIDs(order.items).catch((error) => {
          console.error(error);
          return res
            .status(500)
            .json({ error: "Failed to assign unique order IDs" });
        });

        switch (paymentMethod) {
          case "COD":
            if (!order) {
              return res.status(500).json({ error: "Failed to create order" });
            }

            // Save the order
            const orderPlaced = await order.save();

            if (orderPlaced) {
              // if coupon is used
              if (order.coupon) {
                await Coupon.findOneAndUpdate(
                  { _id: userCart.coupon },
                  { $push: { usedBy: { userId: req.user.id } } }
                );
              }

              // reduce stock of the variant
              for (const item of userCart.items) {
                const product = await Product.findById(item.product_id).catch(
                  (error) => {
                    console.error(error);
                    return res
                      .status(500)
                      .json({ error: "Failed to find product" });
                  }
                );

                if (!product) {
                  return res.status(404).json({ error: "Product not found" });
                }

                const variantIndex = product.variants.findIndex(
                  (variant) =>
                    variant._id.toString() === item.variant.toString()
                );

                if (variantIndex === -1) {
                  return res.status(404).json({ error: "Variant not found" });
                }

                console.log(product.variants[variantIndex]);

                product.variants[variantIndex].stock -= item.quantity;

                await product.save().catch((error) => {
                  console.error(error);
                  return res
                    .status(500)
                    .json({ error: "Failed to update product stock" });
                });
              }
              try {
                // Fetch the current balance from the Ledger
                const ledger = await Ledger.findOne({}); // Assuming only one ledger document

                // Check if the ledger was found
                if (!ledger) {
                  throw new Error("Ledger not found");
                }

                // Calculate the new balance
                const newBalance = ledger.balance + order.payable;

                // Update the Ledger document
                await Ledger.updateOne(
                  {}, // No filter needed since there's only one ledger
                  {
                    $inc: { balance: order.payable },
                    $push: {
                      transactions: {
                        date: new Date(),
                        amount: order.payable,
                        message: "Product Sold",
                        type: "Credit",
                        cBalance: newBalance, // Add cBalance to the transaction
                      },
                    },
                  }
                );

                console.log("Update successful");
              } catch (error) {
                console.error("Error updating ledger:", error);
              }

              await Cart.clearCart(req.user.id).catch((error) => {
                console.error(error);
                return res
                  .status(500)
                  .json({ error: "Failed to clear user's cart" });
              });

              return res.status(200).json({
                success: true,
                message: "Order has been placed successfully.",
              });
            }

            break;

          case "Online":
            const createOrder = await Order.create(order);

            let total = parseInt(userCart.payable);
            let order_id = createOrder._id;

            const RazorpayOrder = await createRazorpayOrder(
              order_id,
              total
            ).then((order) => order);

            const timestamp = RazorpayOrder.created_at;
            const date = new Date(timestamp * 1000); // Convert the Unix timestamp to milliseconds

            // Format the date and time
            const formattedDate = date.toISOString();

            //creating a instance for payment details
            let payment = new Payment({
              payment_id: RazorpayOrder.id,
              amount: parseInt(RazorpayOrder.amount) / 100,
              currency: RazorpayOrder.currency,
              order_id: order_id,
              status: RazorpayOrder.status,
              created_at: formattedDate,
            });

            //saving in to db
            await payment.save();

            return res.json({
              status: true,
              order: RazorpayOrder,
              user,
            });

            break;

          case "Wallet":
            const orderCreate = await Order.create(order);

            if (orderCreate) {
              let wallet = await Wallet.findOne({ userId: req.user.id });

              wallet.balance =
                parseInt(wallet.balance) - parseInt(orderCreate.payable);

              wallet.transactions.push({
                date: new Date(),
                amount: parseInt(orderCreate.payable),
                message: "Order placed successfully",
                type: "Debit",
              });

              await wallet.save();

              try {
                // Fetch the current balance from the Ledger
                const ledger = await Ledger.findOne({}); // Assuming only one ledger document

                // Check if the ledger was found
                if (!ledger) {
                  throw new Error("Ledger not found");
                }

                // Calculate the new balance
                const newBalance = ledger.balance + order.payable;

                // Update the Ledger document
                await Ledger.updateOne(
                  {}, // No filter needed since there's only one ledger
                  {
                    $inc: { balance: order.payable },
                    $push: {
                      transactions: {
                        date: new Date(),
                        amount: order.payable,
                        message: "Product Sold",
                        type: "Credit",
                        cBalance: newBalance, // Add cBalance to the transaction
                      },
                    },
                  }
                );

                console.log("Update successful");
              } catch (error) {
                console.error("Error updating ledger:", error);
              }

              // reduce stock of the variant
              for (const item of userCart.items) {
                const product = await Product.findById(item.product_id).catch(
                  (error) => {
                    console.error(error);
                    return res
                      .status(500)
                      .json({ error: "Failed to find product" });
                  }
                );

                if (!product) {
                  return res.status(404).json({ error: "Product not found" });
                }

                const variantIndex = product.variants.findIndex(
                  (variant) =>
                    variant._id.toString() === item.variant.toString()
                );

                if (variantIndex === -1) {
                  return res.status(404).json({ error: "Variant not found" });
                }

                console.log(product.variants[variantIndex]);

                product.variants[variantIndex].stock -= item.quantity;

                await product.save().catch((error) => {
                  console.error(error);
                  return res
                    .status(500)
                    .json({ error: "Failed to update product stock" });
                });
              }

              await Cart.clearCart(req.user.id);

              orderCreate.status = "Confirmed";
              orderCreate.items.forEach((item) => {
                item.status = "Confirmed";
              });

              await orderCreate.save();

              // coupon is used
              if (order.coupon) {
                await Coupon.findOneAndUpdate(
                  { _id: userCart.coupon },
                  { $push: { usedBy: { userId: req.user.id } } }
                );
              }

              return res.status(200).json({
                success: true,
                message: "Order has been placed successfully.",
              });
            }

            break;

          default:
            return res.status(400).json({ error: "Invalid payment method" });
        }
      }
    } catch (error) {
      console.error(error);
      res
        .status(500)
        .json({ error: "An error occurred while placing the order" });
    }
  },

  verifyPayment: async (req, res) => {
    try {
      const secret = process.env.RAZ_KEY_SECRET;

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
        req.body.response;
      // console.log("payment verification: ", req.body, secret);
      let hmac = crypto.createHmac("sha256", secret);
      hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
      hmac = hmac.digest("hex");
      const isSignatureValid = hmac === razorpay_signature;

      console.log(isSignatureValid);

      if (isSignatureValid) {
        let customer_id = req.user.id;

        let userCart = await Cart.findOne({ userId: customer_id }).catch(
          (error) => {
            console.error(error);
            return res
              .status(500)
              .json({ error: "Failed to find user's cart" });
          }
        );

        // reduce stock of the variant
        for (const item of userCart.items) {
          const product = await Product.findById(item.product_id).catch(
            (error) => {
              console.error(error);
              return res.status(500).json({ error: "Failed to find product" });
            }
          );

          if (!product) {
            return res.status(404).json({ error: "Product not found" });
          }

          const variantIndex = product.variants.findIndex(
            (variant) => variant._id.toString() === item.variant.toString()
          );

          if (variantIndex === -1) {
            return res.status(404).json({ error: "Variant not found" });
          }

          // console.log(product.variants[variantIndex]);

          product.variants[variantIndex].stock -= item.quantity;

          await product.save().catch((error) => {
            console.error(error);
            return res
              .status(500)
              .json({ error: "Failed to update product stock" });
          });
        }

        //empty the cart
        await Cart.clearCart(req.user.id).catch((error) => {
          console.error(error);
          return res.status(500).json({ error: "Failed to clear user's cart" });
        });

        let paymentId = razorpay_order_id;

        const orderID = await Payment.findOne(
          { payment_id: paymentId },
          { _id: 0, order_id: 1 }
        );

        const order_id = orderID.order_id;

        updateOrder = await Order.updateOne(
          { _id: order_id },
          {
            $set: {
              "items.$[].status": "Confirmed",
              "items.$[].paymentStatus": "Paid",
              status: "Confirmed",
              paymentStatus: "Paid",
            },
          }
        );

        let order = await Order.findOne({ _id: order_id }).populate("coupon");

        console.log("order: ", order);
        let couponId;
        // Apply coupon usage if applicable
        if (order.coupon) {
          try {
            couponId = order.coupon._id;
            console.log("coupon : ", couponId);
            if (couponId) {
              const updatedCoupon = await Coupon.findOneAndUpdate(
                { _id: couponId },
                {
                  $push: { usedBy: order.customer_id },
                },
                {
                  new: true,
                }
              );

              if (!updatedCoupon) {
                return res.status(404).json({ error: "Coupon not found" });
              }

              console.log("Coupon updated successfully:", updatedCoupon);
            }
          } catch (error) {
            console.error("Error applying coupon:", error);
            return res.status(500).json({ error: "Failed to apply coupon" });
          }
        }

        try {
          // Fetch the current balance from the Ledger
          const ledger = await Ledger.findOne({}); // Assuming only one ledger document

          // Check if the ledger was found
          if (!ledger) {
            throw new Error("Ledger not found");
          }

          // Calculate the new balance
          const newBalance = ledger.balance + order.payable;

          // Update the Ledger document
          await Ledger.updateOne(
            {}, // No filter needed since there's only one ledger
            {
              $inc: { balance: order.payable },
              $push: {
                transactions: {
                  date: new Date(),
                  amount: order.payable,
                  message: "Product Sold",
                  type: "Credit",
                  cBalance: newBalance, // Add cBalance to the transaction
                },
              },
            }
          );

          console.log("Update successful");
        } catch (error) {
          console.error("Error updating ledger:", error);
        }
        req.session.order = {
          status: true,
        };
        res.json({
          success: true,
        });
      } else {
      }
    } catch (error) {
      console.log(error);
    }
  },
  orderConfirmation: async (req, res) => {},
  orderErrors: async (req, res) => {},

  continueCheckout: async (req, res) => {
    const locals = {
      title: "E-Shopee - Checkout",
    };
    let { orderID, orderStatus } = req.body;
    console.log("Checkout req ", req.body);

    orderStatus = orderStatus === "Failed" ? "Failed" : "";

    if (!req.isAuthenticated()) {
      return res.redirect("/login");
    }

    const userCart = await Order.findById(orderID).populate(
      "items.product_id items.color items.size coupon"
    );
    if (!userCart) {
      return res.redirect("/user/cart");
    }
    if (!userCart.items.length > 0) {
      return res.redirect("/user/cart");
    }

    let user = await User.findById(req.user.id);

    // Correctly use map with async functions
    const productExistencePromises = userCart.items.map((item) =>
      checkProductExistence(item)
    );
    const productExistenceResults = await Promise.allSettled(
      productExistencePromises
    );

    // Filter out the rejected promises to identify which items are not valid
    const invalidCartItems = productExistenceResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);

    if (invalidCartItems.length > 0) {
      console.log(invalidCartItems);
      req.flash(
        "error",
        `The following items are not available: ${invalidCartItems
          .join(", ")
          .replaceAll("Error:", "")}`
      );

      return res.redirect("/user/cart");
    }

    // Correctly use map with async functions
    const stockAvailabilityPromises = userCart.items.map((item) =>
      checkStockAvailability(item)
    );
    const stockAvailabilityResults = await Promise.allSettled(
      stockAvailabilityPromises
    );

    // Filter out the rejected promises to identify which items have insufficient stock
    const insufficientStockItems = stockAvailabilityResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);

    if (insufficientStockItems.length > 0) {
      console.log(insufficientStockItems);
      req.flash(
        "error",
        `Insufficient stock for the following items: ${insufficientStockItems
          .join(", ")
          .replaceAll("Error: ", "")}`
      );

      return res.redirect("/user/cart");
    }

    const address = await Address.find({
      customer_id: req.user.id,
      delete: false,
    });

    let totalPrice = 0;
    let totalPriceBeforeOffer = 0;
    for (const prod of userCart.items) {
      prod.price = prod.product_id.onOffer
        ? prod.product_id.offerDiscountPrice
        : prod.product_id.sellingPrice;

      const itemTotal = prod.price * prod.quantity;
      prod.itemTotal = itemTotal;
      totalPrice += itemTotal;
      totalPriceBeforeOffer += prod.price;
    }

    let deliveryCharge;

    if (totalPrice < 500) {
      deliveryCharge = 40;
    } else if (totalPrice < 1000) {
      deliveryCharge = 30;
    } else if (totalPrice < 3000) {
      deliveryCharge = 20;
    } else {
      deliveryCharge = 0;
    }

    totalPrice += deliveryCharge;

    // for (let prod of userCart.items) {
    //   prod.price = prod.product_id.sellingPrice * prod.quantity;
    //   totalPrice += prod.price; // Calculate total price
    // }

    // Apply coupon discount if applicable
    let couponDiscount = 0;
    if (userCart.coupon) {
      const coupon = await Coupon.findById(userCart.coupon);

      if (
        coupon &&
        coupon.isActive &&
        new Date() <= coupon.expirationDate &&
        totalPrice >= coupon.minPurchaseAmount
      ) {
        couponDiscount = totalPrice * (coupon.rateOfDiscount / 100);
        totalPrice -= couponDiscount;
        totalPrice = Math.round(totalPrice);
      } else {
        // If the total is less than the minimum purchase amount, remove the coupon
        userCart.coupon = undefined;
        userCart.couponDiscount = 0;
        await userCart.save();
      }
    }

    // Update the cart's total price and coupon discount in the database
    userCart.totalPrice = totalPriceBeforeOffer;
    userCart.payable = totalPrice;
    userCart.couponDiscount = couponDiscount;
    console.log(userCart);
    await userCart.save();

    // Correctly calculate cartCount
    let cartCount = userCart.items.length;

    const coupons = await Coupon.find({
      isActive: true,
      // minPurchaseAmount: { $lte: totalPriceBeforeOffer },
      expirationDate: { $gte: Date.now() },
      // usedBy: [{ $: req.user.id }],
    });
    // console.log("coupons", coupons);

    let userWallet = await Wallet.findOne({ userId: req.user.id });

    if (!userWallet) {
      userWallet = {
        balance: 0,
        transactions: [],
        isInsufficient: true,
      };
    }

    let isCOD = true;

    if (totalPrice > 1000) {
      isCOD = false;
    }

    if (totalPrice > userWallet.balance) {
      userWallet.isInsufficient = true;
    } else {
      userWallet.isInsufficient = false;
    }

    res.render("shop/checkout", {
      locals,
      user,
      address,
      userCart,
      isCOD,
      cartList: userCart.items,
      deliveryCharge,
      cartCount,
      coupons,
      totalPrice,
      couponDiscount,
      wallet: userWallet,
      checkout: true,
      orderStatus,
      orderID,
    });
  },
};
