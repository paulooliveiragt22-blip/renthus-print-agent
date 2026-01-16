const usb = require('usb');
const devices = usb.getDeviceList();
devices.forEach(d=>{
  const dd = d.deviceDescriptor;
  console.log(`vendorId(hex)=0x${dd.idVendor.toString(16).padStart(4,'0')}  productId(hex)=0x${dd.idProduct.toString(16).padStart(4,'0')}  vendorId(dec)=${dd.idVendor}  productId(dec)=${dd.idProduct}`);
});
