import Worker from './compiler.worker';
import { Detector } from './detector/detector';
import { buildImageList, buildTrackingImageList } from './image-list';
import { hierarchicalClusteringBuild } from './matching/hierarchical-clustering';
import { encode, decode } from '@msgpack/msgpack';
import tf from '@tensorflow/tfjs';

// 2.1 is @DDincBrents attempt to implement into a node application.
const CURRENT_VERSION = 2.1;

class Compiler {
  constructor() {
    this.data = null;
  }

  // input html Images
  compileImageTargets(images, progressCallback) {
    return new Promise(async (resolve, reject) => {
      const targetImages = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const processCanvas = document.createElement('canvas');
        processCanvas.width = img.width;
        processCanvas.height = img.height;
        const processContext = processCanvas.getContext('2d');
        processContext.drawImage(img, 0, 0, img.width, img.height);
        const processData = processContext.getImageData(0, 0, img.width, img.height);

        const greyImageData = new Uint8Array(img.width * img.height);

        for (let i = 0; i < greyImageData.length; i++) {
          const offset = i * 4;
          greyImageData[i] = Math.floor((processData.data[offset] + processData.data[offset+1] + processData.data[offset+2])/3);
        }
        const targetImage = {data: greyImageData, height: img.height, width: img.width};
        targetImages.push(targetImage);
      }
      
      // compute matching data: 50% progress
      const percentPerImage = 50.0 / targetImages.length;
      let percent = 0.0;
      this.data = [];
      for (let i = 0; i < targetImages.length; i++) {
	const targetImage = targetImages[i];
	const imageList = buildImageList(targetImage);
	const percentPerAction = percentPerImage / imageList.length;
	const matchingData = await _extractMatchingFeatures(imageList, () => {
	  percent += percentPerAction;
	  progressCallback(percent);
	});
	this.data.push({
	  targetImage: targetImage,
	  imageList: imageList,
	  matchingData: matchingData
	});
      }

      for (let i = 0; i < targetImages.length; i++) {
	const trackingImageList = buildTrackingImageList(targetImages[i]);
	this.data[i].trackingImageList = trackingImageList; 
      }

      // compute tracking data with worker: 50% progress
      const compileTrack = () => {
	return new Promise((resolve, reject) => {
	  const worker = new Worker();
	  worker.onmessage = (e) => {
	    if (e.data.type === 'progress') {
	      progressCallback(50 + e.data.percent);
	    } else if (e.data.type === 'compileDone') {
	      resolve(e.data.list);
	    }
	  };
	  worker.postMessage({type: 'compile', targetImages});
	});
      }

      const trackingDataList = await compileTrack();
      for (let i = 0; i < targetImages.length; i++) {
	this.data[i].trackingData = trackingDataList[i];
      }
      resolve(this.data);
    });
  }

  // not exporting imageList because too large. rebuild this using targetImage
  exportData() {
    const dataList = [];
    for (let i = 0; i < this.data.length; i++) {
      dataList.push({
        //targetImage: this.data[i].targetImage,
	targetImage: {
	  width: this.data[i].targetImage.width,
	  height: this.data[i].targetImage.height,
	},
        trackingData: this.data[i].trackingData,
        matchingData: this.data[i].matchingData
      });
    }
    const buffer = encode({
      v: CURRENT_VERSION,
      dataList
    });
    return buffer;
  }

  importData(buffer) {
    const content = decode(new Uint8Array(buffer));
    //console.log("import", content);

    if (!content.v || content.v !== CURRENT_VERSION) {
      console.error("Your compiled .mind might be outdated. Please recompile");
      return [];
    }
    const {dataList} = content;
    this.data = [];
    for (let i = 0; i < dataList.length; i++) {
      this.data.push({
	targetImage: dataList[i].targetImage,
        trackingData: dataList[i].trackingData,
        matchingData: dataList[i].matchingData
      });
    }
    return this.data;
  }
}

const _extractMatchingFeatures = async (imageList, doneCallback) => {
  const keyframes = [];
  for (let i = 0; i < imageList.length; i++) {
    const image = imageList[i];
    // TODO: can improve performance greatly if reuse the same detector. just need to handle resizing the kernel outputs
    const detector = new Detector(image.width, image.height);

    await tf.nextFrame();
    tf.tidy(() => {
      //const inputT = tf.tensor(image.data, [image.data.length]).reshape([image.height, image.width]);
      const inputT = tf.tensor(image.data, [image.data.length], 'float32').reshape([image.height, image.width]);
      //const ps = detector.detectImageData(image.data);
      const {featurePoints: ps} = detector.detect(inputT);

      const maximaPoints = ps.filter((p) => p.maxima); 
      const minimaPoints = ps.filter((p) => !p.maxima); 
      const maximaPointsCluster = hierarchicalClusteringBuild({points: maximaPoints});
      const minimaPointsCluster = hierarchicalClusteringBuild({points: minimaPoints});

      keyframes.push({
	maximaPoints,
	minimaPoints,
	maximaPointsCluster,
	minimaPointsCluster,
	width: image.width,
	height: image.height,
	scale: image.scale
      });
      doneCallback(i);
    });
  }
  return keyframes;
}

export { Compiler }